/* Currency converter — math of the Currency (FX) tab on subnsub.com,
   kept in lockstep with the in-page version.

   Model: one USD-base table drives every pair. The rate document maps
   lowercase currency codes to units-per-USD; a FROM→TO rate is the cross
   rate rateOf(to) / rateOf(from), so any pair works off a single table and
   the base row never needs to exist in the data (rateOf('usd') is defined
   as 1). A missing or non-positive side makes the cross rate NaN — callers
   render that as an em-dash, never as a zero that could pass for a price.

   This module is the pure layer only: no fetch, no storage, no DOM. The
   page fetches the same-origin /api/rates document (payload contract in
   README.md) and hands the decoded JSON to readRatesPayload(); every other
   function takes plain values. Formatting helpers accept a BCP-47 locale
   and fall back to String(v) where Intl is unavailable. */

export const BASE = 'usd';

/* Curated popular set (ISO 4217 + a few majors crypto), shown first in the
   picker. Lowercased to match the API's key casing. (The majors list the
   page draws against FROM is the shorter MAJORS, below.) */
export const POPULAR = ['usd','eur','gbp','jpy','cny','aud','cad','chf','hkd','sgd','inr','krw','nzd','sek','nok','mxn','brl','zar','rub','try','aed','sar','thb','twd','pln','dkk','idr','myr','php','czk','huf','ils','btc','eth'];

/* Built-in English names so the picker reads well even before (or without)
   the network name map. The fetched map fills in the long tail. */
export const BUILTIN_NAMES = {
  usd:'US Dollar', eur:'Euro', gbp:'British Pound', jpy:'Japanese Yen', cny:'Chinese Yuan',
  aud:'Australian Dollar', cad:'Canadian Dollar', chf:'Swiss Franc', hkd:'Hong Kong Dollar',
  sgd:'Singapore Dollar', inr:'Indian Rupee', krw:'South Korean Won', nzd:'New Zealand Dollar',
  sek:'Swedish Krona', nok:'Norwegian Krone', mxn:'Mexican Peso', brl:'Brazilian Real',
  zar:'South African Rand', rub:'Russian Ruble', try:'Turkish Lira', aed:'UAE Dirham',
  sar:'Saudi Riyal', thb:'Thai Baht', twd:'New Taiwan Dollar', pln:'Polish Zloty',
  dkk:'Danish Krone', idr:'Indonesian Rupiah', myr:'Malaysian Ringgit', php:'Philippine Peso',
  czk:'Czech Koruna', huf:'Hungarian Forint', ils:'Israeli Shekel', clp:'Chilean Peso',
  cop:'Colombian Peso', vnd:'Vietnamese Dong', ngn:'Nigerian Naira', egp:'Egyptian Pound',
  pkr:'Pakistani Rupee', bdt:'Bangladeshi Taka', uah:'Ukrainian Hryvnia', ron:'Romanian Leu',
  btc:'Bitcoin', eth:'Ethereum', usdt:'Tether', bnb:'BNB', xrp:'XRP', sol:'Solana',
  ada:'Cardano', doge:'Dogecoin', ltc:'Litecoin',
};

/* ── payload ── */

/* Validate a decoded /api/rates response. Returns { rates, date, names } or
   null when the payload isn't usable. `names` is the sanitized fetched map
   (only non-empty string values kept) or null — a map of 20 entries or fewer
   is discarded as truncated/garbage rather than allowed to shadow the
   builtin set. */
export function readRatesPayload(data){
  if (!(data && data.ok && data.rates && typeof data.rates === 'object')) return null;
  let names = null;
  if (data.names && typeof data.names === 'object' && !Array.isArray(data.names)){
    const m = {};
    for (const k in data.names) if (typeof data.names[k] === 'string' && data.names[k]) m[k] = data.names[k];
    if (Object.keys(m).length > 20) names = m;
  }
  return {
    rates: data.rates,
    date: typeof data.date === 'string' ? data.date : null,
    names,
  };
}

/* Merge a fetched name map over the builtin set (fetched wins). */
export function mergeNames(fetched){
  return Object.assign({}, BUILTIN_NAMES, fetched || {});
}

/* ── cross-rate math ── */

/* Units of `code` per USD; the base itself is 1 by definition, so the table
   never needs a usd row. undefined when the table lacks the code. */
export function rateOf(rates, code){
  return code === BASE ? 1 : (rates ? rates[code] : undefined);
}

/* 1 FROM = crossRate(...) TO. NaN when either side is missing or
   non-positive — a zero/negative rate is upstream garbage, not a price. */
export function crossRate(rates, from, to){
  const rf = rateOf(rates, from), rt = rateOf(rates, to);
  if (!isFinite(rf) || !isFinite(rt) || rf <= 0 || rt <= 0) return NaN;
  return rt / rf;
}

/* amount × cross rate; NaN propagates from a bad amount or a bad pair. */
export function convert(rates, from, to, amount){
  return amount * crossRate(rates, from, to);
}

/* ── code lists ── */

/* Every quotable code: the table's keys plus the base plus the popular set
   (so the picker lists majors even before rates arrive), sorted. */
export function allCodes(rates){
  const set = new Set();
  if (rates) for (const k in rates) set.add(k);
  set.add(BASE);
  POPULAR.forEach(c => set.add(c));
  return Array.from(set).sort();
}

/* Quick-conversion targets: the popular list minus the FROM side,
   restricted to codes the table actually quotes, first 8. Kept for callers
   that want a short tile grid; the site's tiles have given way to the
   majors list (majorRows) with its day/month moves. */
export function quickTargets(rates, from){
  return POPULAR.filter(c => c !== from && isFinite(rateOf(rates, c)) && rateOf(rates, c) > 0).slice(0, 8);
}

/* Display name for a code; the picker shows this beside the code. */
export function nameOf(code, names){
  return (names || BUILTIN_NAMES)[code] || code.toUpperCase();
}

/* Picker search: case-insensitive substring match on the code or the display
   name; exact-code matches sort first, code-prefix matches next, the rest
   alphabetically. Empty query → null (the picker then shows its grouped
   popular/all listing instead of a flat result list). */
export function searchCodes(rates, names, q){
  const all = allCodes(rates);
  const query = (q || '').trim().toLowerCase();
  if (!query) return null;
  return all.filter(c => c.indexOf(query) !== -1 || nameOf(c, names).toLowerCase().indexOf(query) !== -1)
    .sort((a, b) => {                       // exact-code / prefix matches first
      const ap = a === query ? 0 : a.indexOf(query) === 0 ? 1 : 2;
      const bp = b === query ? 0 : b.indexOf(query) === 0 ? 1 : 2;
      return ap - bp || a.localeCompare(b);
    });
}

/* ── amounts & formatting ── */

/* Tolerant amount parsing: drop spaces and grouping separators; accept comma
   as a decimal point only when there's no dot present (de/fr style "1,5"). */
export function parseAmount(s){
  if (s == null) return NaN;
  let t = String(s).trim().replace(/[\s '’]/g, '');
  if (t.indexOf('.') === -1 && (t.match(/,/g) || []).length === 1) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  if (t === '' || t === '.') return NaN;
  const n = Number(t);
  return isFinite(n) ? n : NaN;
}

/* Adaptive precision: big numbers get 2 dp, sub-unit values get more so a
   0.0000123 BTC result isn't flattened to "0.00". */
export function fmtMoney(v, locale){
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  let max;
  if (a === 0) max = 2;
  else if (a >= 1000) max = 2;
  else if (a >= 1) max = 4;
  else if (a >= 0.01) max = 6;
  else max = 8;
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits:max, minimumFractionDigits:0 }).format(v); }
  catch(_){ return String(v); }
}

/* Unit-rate display ("1 USD = …"): a touch more precision than fmtMoney so
   small cross rates stay meaningful. */
export function fmtRate(v, locale){
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  const max = a >= 100 ? 4 : a >= 1 ? 5 : 6;
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits:max, minimumFractionDigits:0 }).format(v); }
  catch(_){ return String(v); }
}

/* Paste-friendly plain number (fixed en-US digits, no grouping) for copy
   actions — grouping separators break spreadsheets and other parsers. */
export function rawString(v){
  if (!isFinite(v)) return '';
  try { return new Intl.NumberFormat('en-US', { maximumFractionDigits:10, useGrouping:false }).format(v); }
  catch(_){ return String(v); }
}

/* iso is the payload's YYYY-MM-DD rate-set date; render date-only in the
   given locale with no timezone shift (the set has no time of day). */
export function fmtDate(iso, locale){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  try {
    const d = new Date(Date.UTC(+m[1], +m[2]-1, +m[3]));
    return new Intl.DateTimeFormat(locale, { year:'numeric', month:'short', day:'numeric', timeZone:'UTC' }).format(d);
  } catch(_){ return iso; }
}

/* ── saved conversions ("<amount> FROM = ? TO" pairs) ──
   A capped, deduped list; the serialized wire/storage shape is
   [{ f, t, a }, …]. The same validation runs on entry and on load so local
   state, what gets saved, and what survives a synced round-trip all agree. */

export const FAV_MAX = 8;

/* Canonical amount string: ≤6 dp, trailing zeros trimmed. */
function cleanPinAmt(n){ return n.toFixed(6).replace(/\.?0+$/, ''); }

/* Validate one pair. Same-currency pairs are rejected (a USD→USD row is
   meaningless and would be dropped in sync anyway); amounts are bounded to
   [1e-6, 1e12). Returns a clean { from, to, amount } or null. */
export function normPin(from, to, amount){
  const code = v => typeof v === 'string' && /^[a-z]{2,12}$/i.test(v);
  const n = parseAmount(amount);
  const f = String(from).toLowerCase(), t = String(to).toLowerCase();
  if (!code(from) || !code(to) || f === t || isNaN(n) || n < 1e-6 || n >= 1e12) return null;
  return { from: f, to: t, amount: cleanPinAmt(n) };
}

/* Identity of a pair — the list is deduped per direction (usd>eur and
   eur>usd are distinct saves). */
export function favKey(f, t){ return String(f).toLowerCase() + '>' + String(t).toLowerCase(); }

/* Sanitize a stored/shared list in the serialized shape: validate each
   entry, dedupe by pair, cap at FAV_MAX. Bad entries drop silently so one
   corrupt row can't take the whole list down. */
export function sanitizeFavs(arr){
  const favs = [];
  if (Array.isArray(arr)){
    const seen = {};
    for (const p of arr){
      if (!p) continue;
      const n = normPin(p.f, p.t, p.a);
      if (!n) continue;
      const k = favKey(n.from, n.to);
      if (seen[k] || favs.length >= FAV_MAX) continue;
      seen[k] = 1; favs.push(n);
    }
  }
  return favs;
}

/* Back to the serialized [{ f, t, a }, …] shape. */
export function serializeFavs(favs){
  return favs.map(p => ({ f:p.from, t:p.to, a:p.amount }));
}

/* Upsert into the list: replace the amount if the pair already exists, else
   append unless at the cap — so a full list still lets you update an
   existing pair instead of trapping you into remove-then-re-add. Mutates
   `favs`; returns true when the pair was stored. */
export function upsertFav(favs, from, to, amount){
  const p = normPin(from, to, amount);
  if (!p) return false;
  const k = favKey(p.from, p.to);
  const at = favs.findIndex(q => favKey(q.from, q.to) === k);
  if (at >= 0) favs[at] = p;
  else if (favs.length < FAV_MAX) favs.push(p);
  else return false;
  return true;
}

/* ── history: a pair over time ──
   /api/rates-history (contract in README.md) samples the same open daily
   tables /api/rates reads, as units per US dollar on each sampled day; a
   pair's rate on a day is TO's units over FROM's, exactly as crossRate()
   does it live. Everything below eats the decoded document as plain data:
   the page fetches, caches and repaints; the module only computes. */

/* Ranges the page offers, in display order; the sampling cadence behind
   each is the server's business. */
export const HISTORY_RANGES = ['1m', '3m', '1y'];

/* The majors shown against FROM on the page, in display order. */
export const MAJORS = ['usd','eur','jpy','gbp','cny','hkd','aud','cad','chf','sgd','krw','btc'];

/* Validate a decoded /api/rates-history response. Returns { dates, series }
   or null when the payload isn't usable — fewer than two dated points is no
   history, and every date must be a bare YYYY-MM-DD. */
export function readHistoryPayload(d){
  const ok = d && d.ok && Array.isArray(d.dates) && d.dates.length >= 2 && d.series && typeof d.series === 'object'
    && d.dates.every(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x));
  return ok ? { dates: d.dates, series: d.series } : null;
}

/* The codes a history request may name: only a code's shape is ever put in
   a request (the pair comes from saved prefs as well as the pickers), each
   once, sorted so equal sets build equal cache keys. */
export function historyCodes(codes){
  return Array.from(new Set((codes || []).filter(c => typeof c === 'string' && /^[a-z0-9]{2,12}$/.test(c)))).sort();
}

/* What the page asks for: the month's table carries the majors and the pair
   in one request (it feeds the overview, the majors list and the 1M chart);
   a quarter or a year is asked for the pair alone. → { range, codes } */
export function historyRequest(range, from, to){
  return range === '1m'
    ? { range: '1m', codes: historyCodes(MAJORS.concat([from, to])) }
    : { range, codes: historyCodes([from, to]) };
}

/* [[iso, rate], …] for FROM → TO over a history, ascending by date. Days
   where either side is missing or non-positive are skipped, and the base
   itself is 1 on every day (the tables never carry a usd row).
   With a live table and its date, the live rate is laid over the newest
   point (or appended after it when the table is newer), so a chart always
   ends on the number the converter shows. */
export function pairPoints(hist, from, to, rates, date){
  const pts = [];
  if (hist){
    const fs = hist.series[from], ts = hist.series[to];
    hist.dates.forEach((d, i) => {
      const f = from === BASE ? 1 : (Array.isArray(fs) ? fs[i] : null);
      const t = to === BASE ? 1 : (Array.isArray(ts) ? ts[i] : null);
      if (typeof f === 'number' && typeof t === 'number' && f > 0 && t > 0) pts.push([d, t / f]);
    });
  }
  const live = crossRate(rates, from, to);
  if (pts.length && typeof date === 'string' && isFinite(live)){
    const last = pts[pts.length - 1];
    if (date === last[0]) last[1] = live;
    else if (date > last[0]) pts.push([date, live]);
  }
  return pts;
}

/* Relative change from a to b; NaN unless a is a positive rate. */
export function pctChange(a, b){ return a > 0 && isFinite(b) ? (b - a) / a : NaN; }

/* [before, last] for the day's move: the point dated exactly one day before
   the last, or null — over a day the tables are missing, a two-day move is
   not a 1D. */
export function dayPair(pts){
  const n = pts.length;
  if (n < 2) return null;
  const want = new Date(Date.parse(pts[n - 1][0]) - 86400000).toISOString().slice(0, 10);
  for (let i = n - 2; i >= 0 && pts[i][0] >= want; i--) if (pts[i][0] === want) return [pts[i][1], pts[n - 1][1]];
  return null;
}

/* The range's figures over a point list: high/low with their dates, the
   mean, and the move from the first point to the last. null below two
   points. */
export function rangeStats(pts){
  if (!pts || pts.length < 2) return null;
  let hi = -Infinity, lo = Infinity, sum = 0, hiD = '', loD = '';
  for (const [d, v] of pts){ sum += v; if (v > hi){ hi = v; hiD = d; } if (v < lo){ lo = v; loD = d; } }
  const first = pts[0][1], last = pts[pts.length - 1][1];
  return { high: hi, highDate: hiD, low: lo, lowDate: loD, avg: sum / pts.length,
    first, last, change: last - first, pct: pctChange(first, last) };
}

/* Direction class for a relative move: 'up' / 'down' / 'flat' — below half
   a basis point reads as flat, and so does NaN. */
export function moveOf(p){ return !isFinite(p) || Math.abs(p) < 5e-5 ? 'flat' : p > 0 ? 'up' : 'down'; }

/* Signed percentage, two decimals ("+1.23%"); '—' for NaN. */
export function fmtPct(p, locale){
  if (!isFinite(p)) return '—';
  try { return new Intl.NumberFormat(locale, { style:'percent', minimumFractionDigits:2, maximumFractionDigits:2, signDisplay:'exceptZero' }).format(p); }
  catch(_){ return (p > 0 ? '+' : '') + (p * 100).toFixed(2) + '%'; }
}

/* Signed absolute move at fmtRate's precision ("+0.0123"); '—' for NaN. */
export function fmtDelta(v, locale){
  if (!isFinite(v)) return '—';
  const a = Math.abs(v), max = a >= 100 ? 4 : a >= 1 ? 5 : 6;
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits:max, minimumFractionDigits:0, signDisplay:'exceptZero' }).format(v); }
  catch(_){ return (v > 0 ? '+' : '') + String(v); }
}

/* ── chart model ── */

/* An SVG path for a point list in a w×h box: x by date (not by index, so a
   sparser range keeps its time axis straight), y by rate with 8% headroom
   above and below; a flat series gets a 2% band so it still draws a line.
   → { d, xs } — the path string and each point's x, for the hover/keyboard
   readout to look up. Needs at least one point. */
export function sparkPath(pts, w, h){
  let lo = Infinity, hi = -Infinity;
  for (const p of pts){ if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
  let span = hi - lo; if (span <= 0) span = Math.abs(hi) * 0.02 || 1;
  lo -= span * 0.08; hi += span * 0.08;
  const t0 = Date.parse(pts[0][0]), t1 = Date.parse(pts[pts.length - 1][0]);
  const xs = pts.map(p => ((Date.parse(p[0]) - t0) / ((t1 - t0) || 1)) * w);
  const Y = v => h - (v - lo) / (hi - lo) * h;
  let d = '';
  pts.forEach((p, i) => { d += (i ? 'L' : 'M') + xs[i].toFixed(2) + ',' + Y(p[1]).toFixed(2) + ' '; });
  return { d: d.trim(), xs };
}

/* The point nearest an x in the chart's own box (binary search over the
   ascending xs sparkPath returned): which day a pointer is over. */
export function nearestIndex(xs, x){
  let lo = 0, hi = xs.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1){ const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid; else hi = mid; }
  return (Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x)) ? lo : hi;
}

/* ── majors & ladders ── */

/* The rows of the majors list against FROM: every major but FROM itself,
   with TO leading when it is not one of them. */
export function majorRows(from, to){
  const rows = MAJORS.filter(c => c !== from);
  if (to !== from && rows.indexOf(to) === -1) rows.unshift(to);
  return rows;
}

/* A ready reckoner: round sums of `a` in `b`, the sums scaled to what `a`
   is worth against the dollar (100 yen, 0.00001 BTC) so the first row is
   roughly a dollar's worth. → [[amountA, amountB], …] × 8, or null when
   the pair can't be quoted. Call twice, swapped, for both directions. */
export function ladderRows(rates, a, b){
  const ra = rateOf(rates, a), rb = rateOf(rates, b);
  if (!isFinite(ra) || !isFinite(rb) || ra <= 0 || rb <= 0) return null;
  const k = Math.round(Math.log10(ra) - 0.35);
  return [1, 5, 10, 50, 100, 500, 1000, 5000].map(m => {
    const x = Number((m * Math.pow(10, k)).toPrecision(12));
    return [x, x * rb / ra];
  });
}
