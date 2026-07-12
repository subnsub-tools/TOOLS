/* Today aggregate — core logic of the Today tab on subnsub.com, kept in
   lockstep with the in-page version.

   Today is a dashboard that aggregates the user's favourites from other
   tabs into per-tool tiles: weather cities, currency conversions, the
   stock watchlist, today's World Cup matches and the Timer tab's day
   counters. This module owns the three mechanisms that make it tick —
   the DOM tiles themselves stay on-site (the adapter contract each tile
   implements is documented in the README):

   1. The pin model. dt-today-pins is an ORDERED set of pinned tool ids;
      parsing whitelists ids, drops duplicates and degrades the legacy
      per-instance object form; an empty board serialises to "absent",
      not to "[]", so the default state round-trips through config sync.
   2. The refresh discipline. Each tool's data lives in small state
      entries { data, fetchedAt, loading, err } with a per-tool TTL.
      Only what the board actually shows is fetched; a failed fetch
      back-dates fetchedAt so the entry retries on a short window (~30s)
      instead of pinning the failure for a whole TTL, and the fx table
      ties freshness to the cached table's OWN timestamp so a 59-minute-
      old table can't masquerade as fresh for another hour.
   3. The signature render criterion. A tile only rebuilds when its
      signature changes, and signatures sign the RENDERED PAYLOAD (plus
      language / unit / zone inputs) — never fetchedAt — so a TTL refresh
      returning identical data never churns DOM identity.

   Time-zone handling: the board can be pinned to any IANA zone; every
   "which day is it?" question is answered there. Zone strings coming
   from sync are validated once per value and fold to browser-local when
   invalid. All functions are pure of network/storage/DOM: payloads,
   parsed storage values and clocks come in as arguments. */

export const KNOWN_TOOLS = ['weather', 'fx', 'stock', 'worldcup', 'countdown'];

/* Per-tool freshness windows (ms). countdown is pure local: no TTL. */
export const TTL = { weather: 900000, fx: 3600000, stock: 120000, worldcup: 120000 };

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const CUR_RE = /^[a-z]{2,12}$/;
/* Favourite-list caps mirror the source tools, so a crafted or stale
   stored list can't fan out unbounded fetches or an oversized board. */
const WX_MAX = 10, FX_MAX = 8, STK_MAX = 12;

/* ── pin model: an ordered list of tool ids ──────────────────────────
   raw = the stored serialised string (or null/undefined). Accepts plain
   ids (current form) or the legacy instance objects (degrade to .t);
   unknown ids and duplicates are dropped, order is preserved. */
export function parsePins(raw, known){
  known = known || KNOWN_TOOLS;
  if (!raw) return [];
  const out = [], seen = {};
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    arr.forEach(p => {
      const id = typeof p === 'string' ? p : (p && typeof p === 'object' && typeof p.t === 'string' ? p.t : null);
      if (known.indexOf(id) !== -1 && !seen[id]) { seen[id] = 1; out.push(id); }
    });
  } catch (_) { return []; }
  return out;
}

/* Nothing pinned = default = key absent: returns null so callers remove
   the stored key instead of writing "[]". */
export function serializePins(pins){
  return pins && pins.length ? JSON.stringify(pins) : null;
}

/* Toggle a tool on/off the board. Unpin always works; only NEW pins are
   gated by maxPins (the site configures that cap on its own side).
   Returns { pins, changed, capped } — pins is a new array when changed. */
export function togglePin(pins, id, opts){
  opts = opts || {};
  const known = opts.known || KNOWN_TOOLS;
  if (known.indexOf(id) === -1) return { pins, changed: false, capped: false };
  const i = pins.indexOf(id);
  if (i >= 0) {
    const next = pins.slice();
    next.splice(i, 1);
    return { pins: next, changed: true, capped: false };
  }
  if (opts.maxPins != null && pins.length >= opts.maxPins) {
    return { pins, changed: false, capped: true };
  }
  return { pins: pins.concat(id), changed: true, capped: false };
}

/* ── time zone + day math ────────────────────────────────────────────
   Zones arrive from storage/sync and may be junk — validate once per
   value: a corrupt or sync-imported zone folds to browser-local
   everywhere at once, and the probe never repeats for the same string. */
export function makeZoneCheck(){
  let okV = '', badV = '';
  return function(z){
    if (!z || z === okV) return z || '';
    if (z === badV) return '';
    try { new Date().toLocaleDateString('en-CA', { timeZone: z }); okV = z; return z; }
    catch (_) { badV = z; return ''; }
  };
}

export function localDateKey(d){
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* The board's current YYYY-MM-DD in the chosen zone ('' = browser). */
export function dayKey(tz, now){
  const n = now ? new Date(now) : new Date();
  if (!tz) return localDateKey(n);
  try { return n.toLocaleDateString('en-CA', { timeZone: tz }); }
  catch (_) { return localDateKey(n); }
}

/* A local Date at midnight of "today in the board's zone" — the base
   every day-difference computation counts from. */
export function todayMid(tz, now){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey(tz, now));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const n = now ? new Date(now) : new Date();
  n.setHours(0, 0, 0, 0);
  return n;
}

export function isoWeek(d){
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

/* The date-header numbers: year, ISO week, day-of-year and year length. */
export function dateFacts(tz, now){
  const mid = todayMid(tz, now), y = mid.getFullYear();
  const doy = Math.round((mid - new Date(y, 0, 1)) / 86400000) + 1;
  const total = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  return { year: y, week: isoWeek(mid), dayOfYear: doy, daysInYear: total };
}

/* ── favourite lists (parsed storage values in, clean lists out) ─────
   Inputs are the source tools' own stored values, already JSON-parsed;
   each list is validated, de-duplicated and capped here. */

/* wx-favs: [{ name, country }] → city name list. */
export function wxFavCities(favs){
  const out = [], seen = {};
  if (Array.isArray(favs)) favs.forEach(f => {
    const n = f && f.name ? String(f.name).trim() : '';
    if (n && !seen[n.toLowerCase()] && out.length < WX_MAX) { seen[n.toLowerCase()] = 1; out.push(n); }
  });
  return out;
}

/* fx-favs: [{ f, t, a }] → [{ f, x, a }] (from, to, amount). A legacy
   single fx-pin still counts as a favourite until the Currency tab
   migrates it — surfaced here too so an old pin isn't invisible. */
export function fxFavList(favs, legacyPin){
  const out = [], seen = {};
  if (Array.isArray(favs)) favs.forEach(p => {
    if (!p || out.length >= FX_MAX) return;
    const f = String(p.f || '').toLowerCase(), t = String(p.t || '').toLowerCase();
    const amt = parseFloat(p.a);
    if (!CUR_RE.test(f) || !CUR_RE.test(t) || f === t || !isFinite(amt) || amt <= 0 || amt >= 1e12) return;
    const k = f + '>' + t;
    if (seen[k]) return;
    seen[k] = 1;
    out.push({ f: f, x: t, a: amt });
  });
  if (!out.length && legacyPin) {
    const pf = String(legacyPin.f || '').toLowerCase(), pt = String(legacyPin.t || '').toLowerCase();
    const pa = parseFloat(legacyPin.a);
    if (CUR_RE.test(pf) && CUR_RE.test(pt) && pf !== pt && isFinite(pa) && pa > 0 && pa < 1e12) out.push({ f: pf, x: pt, a: pa });
  }
  return out;
}

/* stk-favs: ["TICKER", …] → validated upper-case ticker list. */
export function stkFavList(favs){
  const out = [], seen = {};
  if (Array.isArray(favs)) favs.forEach(s => {
    const t = typeof s === 'string' ? s.toUpperCase() : '';
    if (TICKER_RE.test(t) && !seen[t] && out.length < STK_MAX) { seen[t] = 1; out.push(t); }
  });
  return out;
}

/* ── refresh discipline ──────────────────────────────────────────────
   State entries are plain mutable records shared between the scheduler
   and the settle functions; pools key them per city / per ticker. */

export function poolEntry(pool, k){
  return pool[k] || (pool[k] = { data: null, fetchedAt: 0, loading: false, err: false });
}

export function due(st, ttl, now){
  return !st || (now || Date.now()) - st.fetchedAt > ttl;
}

/* Which fetches a tool needs right now — only what the board actually
   shows. shown = { weather: [cities], fx: [pairs], stock: [tickers] };
   pools = { weather: {}, stock: {}, fx: entry, worldcup: entry }.
   Returns the due keys (city names / tickers; a singleton marker for
   fx / worldcup). countdown is pure local: render-only, never fetched. */
export function dueFetches(id, shown, pools, now){
  const keys = [];
  if (id === 'weather') {
    (shown.weather || []).forEach(c => { if (due(pools.weather[c.toLowerCase()], TTL.weather, now)) keys.push(c); });
  } else if (id === 'fx') {
    if ((shown.fx || []).length && due(pools.fx, TTL.fx, now)) keys.push('fx');
  } else if (id === 'stock') {
    (shown.stock || []).forEach(s => { if (due(pools.stock[s], TTL.stock, now)) keys.push(s); });
  } else if (id === 'worldcup') {
    if (due(pools.worldcup, TTL.worldcup, now)) keys.push('worldcup');
  }
  return keys;
}

/* On a day roll (dayKey changed) the date-sensitive pools go stale at
   once: every weather city (its "today" forecast row moved) and the
   World Cup window. On a UI-language change the site resets the weather
   pool the same way — condition text is language-baked into the payload
   but the pool is keyed by city only. */
export function resetPool(pool){
  Object.keys(pool).forEach(k => { pool[k].fetchedAt = 0; });
}

/* A stored weather "city" may actually be a lat,lon pair (the Weather
   tab saves coordinates after a geolocation lookup) — route accordingly. */
export function wxRequest(q){
  return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(q)
    ? { lat: q.split(',')[0], lon: q.split(',')[1] }
    : { q: q };
}

/* The World Cup tile fetches a local-time ±1 day window. */
export function wcFetchRange(now){
  const n = now ? new Date(now) : new Date();
  const d0 = new Date(n); d0.setDate(d0.getDate() - 1);
  const d1 = new Date(n); d1.setDate(d1.getDate() + 1);
  return { dateFrom: localDateKey(d0), dateTo: localDateKey(d1) };
}

/* Settle functions: apply a fetch outcome to a state entry. payload =
   the parsed response body, or null/undefined for a network failure.
   The failure branches back-date fetchedAt to TTL−30s (fx: TTL−60s) so
   the entry retries on a short window instead of a whole TTL. */

export function settleWeather(st, payload, now){
  now = now || Date.now();
  st.loading = false;
  if (payload && payload.ok) { st.data = payload; st.err = false; st.fetchedAt = now; }
  else { st.err = true; st.fetchedAt = now - TTL.weather + 30000; }
  return st;
}

/* Stocks keep the stale quote on a failed refresh (better a delayed
   price than a blank row); only a never-loaded entry gets the short
   retry window. */
export function settleStock(st, payload, now){
  now = now || Date.now();
  st.loading = false;
  st.fetchedAt = now;
  if (payload && payload.ok) { st.data = payload; st.err = false; }
  else { st.err = true; if (!st.data) st.fetchedAt = now - TTL.stock + 30000; }
  return st;
}

export function settleWorldcup(st, payload, now){
  now = now || Date.now();
  st.loading = false;
  if (payload && payload.ok && Array.isArray(payload.matches)) { st.data = payload.matches; st.err = false; st.fetchedAt = now; }
  else { st.err = true; st.fetchedAt = now - TTL.worldcup + 30000; }
  return st;
}

/* The fx tile shares one rate table with the Currency tab through a
   cached { date, rates, fetched } record. */
export function validFxCache(c){
  return c && typeof c.rates === 'object' && c.rates ? c : null;
}

export function fxCacheFresh(c, now){
  return !!(c && (now || Date.now()) - (c.fetched || 0) < TTL.fx);
}

/* Adopting a fresh cached table ties freshness to the cache's OWN
   timestamp — stamping Date.now() would let a 59-min-old table look
   fresh for another full TTL. */
export function adoptFxCache(st, c){
  st.data = c;
  st.err = false;
  st.fetchedAt = c.fetched || Date.now();
  return st;
}

/* staleCache = the (validated) previous table, if any: a failed refresh
   shows it rather than an error, but keeps a short retry window
   (not a full hour). Returns the record to persist back when fresh. */
export function settleFx(st, payload, staleCache, now){
  now = now || Date.now();
  st.loading = false;
  if (payload && payload.ok && payload.rates) {
    st.data = { date: payload.date, rates: payload.rates, fetched: now };
    st.err = false;
    st.fetchedAt = now;
  } else if (staleCache) { st.data = staleCache; st.err = false; st.fetchedAt = now - TTL.fx + 60000; }
  else { st.err = true; st.fetchedAt = now - TTL.fx + 60000; }
  return st;
}

/* ── signature render criterion ──────────────────────────────────────
   A tile rebuilds only when its signature changes. Signatures sign the
   rendered payload plus the display inputs (language, °F flag, zone,
   day key) — NEVER fetchedAt — so a refresh returning identical data is
   a render no-op and row identity survives. Loading and error states
   sign as '-' and 'e'. */

export function weatherSig(cities, pool, opts){
  opts = opts || {};
  return 'wx|' + !!opts.fahrenheit + '|' + (opts.lang || '') + '|' + cities.map(c => {
    const st = pool[c.toLowerCase()];
    return c + ':' + (st && st.data
      ? JSON.stringify(st.data.current) + '|' + JSON.stringify(st.data.location) + '|' + (st.data.forecast && st.data.forecast[0] ? JSON.stringify(st.data.forecast[0]) : '')
      : st && st.err ? 'e' : '-');
  }).join(',');
}

export function fxSig(list, st, lang){
  const rates = st.data && st.data.rates;
  return 'fx|' + (lang || '') + '|' + (st.data ? st.data.date : st.err ? 'e' : '-') + '|' + list.map(p => {
    const r = rates ? (p.f === 'usd' ? 1 : rates[p.f]) : null;
    const r2 = rates ? (p.x === 'usd' ? 1 : rates[p.x]) : null;
    return p.f + '>' + p.x + '@' + p.a + '=' + r + '/' + r2;
  }).join(',');
}

export function stockSig(syms, pool, lang){
  return 'stk|' + (lang || '') + '|' + syms.map(s => {
    const st = pool[s];
    return s + ':' + (st && st.data ? JSON.stringify(st.data) : st && st.err ? 'e' : '-');
  }).join(',');
}

export function worldcupSig(st, timeZone, lang, now){
  if (!st.data) return 'wc|msg|' + st.err + '|' + (lang || '');
  const todayKey = wcDateInTZ(new Date(now || Date.now()).toISOString(), timeZone);
  const ms = todaysMatches(st.data, timeZone, now);
  return 'wc|ok|' + todayKey + '|' + (timeZone || '') + '|' + (lang || '') + '|' + JSON.stringify(ms);
}

/* raw = the stored day-counter string as-is: the tile re-signs on day
   roll (dayKey) and on any edit (raw), without parsing anything. */
export function countdownSig(raw, tz, lang, now){
  return 'cd|' + dayKey(tz, now) + '|' + (raw || '') + '|' + (lang || '');
}

/* ── per-tool render-data shaping ────────────────────────────────────
   Plain data out; the site's tiles turn these into DOM. */

/* Weather card: one favourite city row.
   opts: { fahrenheit, feelsLabel } (label is i18n'd on-site). */
export function wxCard(city, st, opts){
  opts = opts || {};
  const f = !!opts.fahrenheit;
  const tN = (c, ff) => { const v = f ? ff : c; return v != null && isFinite(v) ? Math.round(v) + '°' : '--°'; };
  if (!st || !st.data) return { city: city, pending: !(st && st.err), err: !!(st && st.err) };
  const d = st.data, cur = d.current || {}, place = d.location || {};
  const tv = f ? cur.temp_f : cur.temp_c;
  let feels = (opts.feelsLabel || 'Feels like') + ' ' + tN(cur.feelslike_c, cur.feelslike_f);
  const f0 = (d.forecast && d.forecast[0]) || null;
  if (f0 && (f0.maxtemp_c != null || f0.maxtemp_f != null)) feels += '  ·  H:' + tN(f0.maxtemp_c, f0.maxtemp_f) + '  L:' + tN(f0.mintemp_c, f0.mintemp_f);
  return {
    city: String(place.name || city) + (place.country ? ', ' + String(place.country) : ''),
    temp: (tv != null && isFinite(tv) ? Math.round(tv) : '--') + (f ? '°F' : '°C'),
    condition: cur.condition ? String(cur.condition) : '',
    feels: feels,
    icon: cur.icon,
  };
}

/* Currency rows: one line per favourite pair, cross-rated through the
   USD-based table; unresolvable pairs are skipped, decimals widen as
   the value shrinks. */
export function fxRows(list, rates, lang){
  const rateOf = c => c === 'usd' ? 1 : (typeof rates[c] === 'number' ? rates[c] : NaN);
  const rows = [];
  list.forEach(p => {
    const r = rateOf(p.x) / rateOf(p.f);
    if (!isFinite(r) || r <= 0) return;
    const v = p.a * r;
    const digits = v >= 100 ? 2 : v >= 1 ? 4 : 6;
    let vs, as;
    try { vs = v.toLocaleString(lang, { maximumFractionDigits: digits }); } catch (_) { vs = v.toFixed(digits); }
    try { as = p.a.toLocaleString(lang, { maximumFractionDigits: 2 }); } catch (_) { as = String(p.a); }
    rows.push(as + ' ' + p.f.toUpperCase() + ' = ' + vs + ' ' + p.x.toUpperCase());
  });
  return rows;
}

/* Stock row pieces: sub-1 prices get four decimals, everything else two. */
export function fmtPrice(v){
  if (v == null || !isFinite(v)) return '--';
  return v.toFixed(Math.abs(v) < 1 ? 4 : 2);
}

/* → { up, text } or null when the quote carries no usable change. */
export function stockChange(d){
  if (!d || d.change == null || d.changePct == null || !isFinite(d.changePct)) return null;
  const up = d.change >= 0;
  return { up: up, text: (up ? '+' : '−') + Math.abs(d.changePct).toFixed(2) + '%' };
}

/* World Cup: today's matches in the board's zone (en-CA = stable
   YYYY-MM-DD day key). The tile shows at most the first 6. */
export function wcDateInTZ(iso, timeZone){
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString('en-CA', timeZone ? { timeZone: timeZone } : {}); }
  catch (_) { return String(iso).slice(0, 10); }
}

export function todaysMatches(matches, timeZone, now){
  if (!matches) return [];
  const todayKey = wcDateInTZ(new Date(now || Date.now()).toISOString(), timeZone);
  return matches.filter(m => m && m.utcDate && wcDateInTZ(m.utcDate, timeZone) === todayKey);
}

/* One compact match row: a badge for anything in/after play (LIVE / HT /
   FT, and — for the abandoned states), the kickoff time otherwise; the
   score only once both sides carry one. opts: { timeZone, locale,
   liveLabel } (the LIVE badge is i18n'd on-site). */
export function wcMatchRow(m, opts){
  opts = opts || {};
  const h = m.homeTeam || {}, a = m.awayTeam || {};
  const live = m.status === 'IN_PLAY';
  const badge = live ? (opts.liveLabel || 'LIVE')
    : m.status === 'PAUSED' ? 'HT'
    : m.status === 'FINISHED' ? 'FT'
    : m.status === 'POSTPONED' || m.status === 'CANCELLED' || m.status === 'SUSPENDED' ? '—'
    : '';
  const scored = h.score != null && a.score != null;
  let time = '', score = null;
  if (scored) {
    score = h.score + ' : ' + a.score;
  } else if (!badge) {
    const ko = new Date(m.utcDate);
    try {
      const tOpts = { hour: '2-digit', minute: '2-digit' };
      if (opts.timeZone) tOpts.timeZone = opts.timeZone;
      time = ko.toLocaleTimeString(opts.locale, tOpts);
    } catch (_) { time = ko.getHours() + ':' + String(ko.getMinutes()).padStart(2, '0'); }
  }
  return {
    badge: badge, live: live, hot: live || m.status === 'PAUSED',
    scored: scored, score: score, time: time, home: h, away: a,
  };
}

/* ── day counters (Timer tab data, pure local) ───────────────────────
   items: [{ d: 'YYYY-MM-DD', t: title }]; mid = todayMid(tz). */

export function parseCounters(raw){
  let items = [];
  try {
    const v = JSON.parse(raw || '[]');
    if (Array.isArray(v)) items = v.filter(it => it && typeof it.d === 'string');
  } catch (_) {}
  return items;
}

/* Signed day distance to the target date (positive = upcoming). */
export function cdDays(iso, mid){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return 0;
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  return Math.round((target - mid) / 86400000);
}

/* Upcoming counters first (soonest on top), past ones after (most
   recent first). The tile shows at most the first 6. */
export function sortCounters(items, mid){
  return items.slice().sort((a, b) => {
    const da = cdDays(a.d, mid), db = cdDays(b.d, mid);
    const fa = da >= 0 ? 0 : 1, fb = db >= 0 ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return fa === 0 ? da - db : db - da;
  });
}

/* D-day label: D-n counting down, D+n counting up, todayLabel on the
   day itself (i18n'd on-site). */
export function cdLabel(days, todayLabel){
  return days === 0 ? (todayLabel || 'Today') : days > 0 ? 'D-' + days : 'D+' + (-days);
}
