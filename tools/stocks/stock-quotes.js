/* Stock quotes — core data layer of the Stocks tab on subnsub.com, kept in
   lockstep with the in-page version.

   The page fetches two same-origin JSON documents (/api/stocks for the
   quote, /api/stock-history for the daily close series — payload contracts
   in README.md) and hands the decoded objects here. This module is the pure
   layer between those payloads and the screen: payload validation and
   normalization, price / percent / market-cap formatting, the watchlist
   list model, and the price-history chart math (range slicing, viewBox
   scaling, SVG path strings, nearest-point hover lookup). No fetch, no
   storage, no DOM — the chart helpers return path strings and coordinates;
   drawing them is the caller's job.

   Quotes may be delayed: the server's end-of-day fallback marks its
   responses with `delayed: true` (price = last close), and honest UIs
   surface that flag rather than presenting stale data as live. */

/* Curated popular US large-caps for the quick-pick chips + typeahead.
   Static so suggest-as-you-type costs no request and can't burn the data
   providers' daily caps. Tickers are dot-free so the server's name→symbol
   search resolves them directly. */
export const POPULAR = [
  ['AAPL','Apple'],['MSFT','Microsoft'],['NVDA','NVIDIA'],['GOOGL','Alphabet'],
  ['AMZN','Amazon'],['META','Meta'],['TSLA','Tesla'],['AVGO','Broadcom'],
  ['AMD','AMD'],['NFLX','Netflix'],['JPM','JPMorgan'],['V','Visa'],
  ['MA','Mastercard'],['WMT','Walmart'],['COST','Costco'],['DIS','Disney'],
  ['KO','Coca-Cola'],['MCD','McDonald’s'],['BA','Boeing'],['INTC','Intel'],
];

/* Typeahead filter: case-insensitive substring match on the ticker or the
   company name; an empty query keeps the whole list. Returns [ticker, name]
   pairs in POPULAR order. */
export function filterPopular(q){
  const query = (q || '').trim().toLowerCase();
  return POPULAR.filter(([t, n]) =>
    !query || t.toLowerCase().indexOf(query) !== -1 || n.toLowerCase().indexOf(query) !== -1);
}

/* ── watchlist ──
   A capped, deduped list of uppercase tickers; serialized as a plain JSON
   array of strings. The same validation runs on load and on toggle so a
   synced or hand-edited list can't smuggle junk in. */

export const WATCH_MAX = 12;
export const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/* Sanitize a stored/synced list: strings only, uppercased, ticker-shaped,
   deduped, capped. Bad entries drop silently. */
export function sanitizeWatchlist(a){
  if (!Array.isArray(a)) return [];
  const out = [], seen = {};
  for (const s of a){
    const t = typeof s === 'string' ? s.toUpperCase() : '';
    if (TICKER_RE.test(t) && !seen[t] && out.length < WATCH_MAX){ seen[t] = 1; out.push(t); }
  }
  return out;
}

/* Toggle a symbol: present → remove; absent → append unless the list is
   full. Invalid tickers are ignored. Mutates and returns `list`. */
export function toggleWatch(list, sym){
  sym = String(sym || '').toUpperCase();
  if (!TICKER_RE.test(sym)) return list;
  const i = list.indexOf(sym);
  if (i >= 0) list.splice(i, 1);
  else if (list.length < WATCH_MAX) list.push(sym);
  return list;
}

/* ── formatting ──
   Null/non-finite inputs render as an em-dash (or empty for the cap) — the
   payload legitimately carries nulls for fields a provider didn't have. */

export function fmtPrice(n, locale){
  if (n == null || !isFinite(n)) return '—';
  const max = Math.abs(n) >= 1 ? 2 : 4;   // penny stocks keep 4 dp
  try { return new Intl.NumberFormat(locale, { minimumFractionDigits:2, maximumFractionDigits:max }).format(n); }
  catch(_){ return Number(n).toFixed(2); }
}

export function fmtPct(n, locale){
  if (n == null || !isFinite(n)) return '—';
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits:2, minimumFractionDigits:2 }).format(n); }
  catch(_){ return Number(n).toFixed(2); }
}

/* m is in MILLIONS of the quote currency (the /api/stocks convention).
   Prefers Intl compact currency notation; the fallback hand-rolls T/B/M
   units for engines without it. */
export function fmtMktCap(m, cur, locale){
  if (m == null || !isFinite(m) || m <= 0) return '';
  try { return new Intl.NumberFormat(locale, { style:'currency', currency: cur || 'USD', notation:'compact', maximumFractionDigits:2 }).format(m * 1e6); }
  catch(_){
    const a = Math.abs(m); let v, u;
    if (a >= 1e6){ v = m / 1e6; u = 'T'; } else if (a >= 1e3){ v = m / 1e3; u = 'B'; } else { v = m; u = 'M'; }
    return (cur ? cur + ' ' : '$') + v.toFixed(2) + u;
  }
}

/* Signed daily-change line, e.g. "+1.23 (+1.01%)". The sign is applied to
   both parts (values are formatted from their absolutes) and uses a true
   minus (U+2212), not a hyphen. Returns { up, text } — `up` drives the
   up/down coloring — or null when the payload carries no change data. */
export function fmtChange(change, changePct, locale){
  if (change == null || changePct == null) return null;
  const up = change >= 0;
  const sign = up ? '+' : '−';
  return { up, text: sign + fmtPrice(Math.abs(change), locale) + ' (' + sign + fmtPct(Math.abs(changePct), locale) + '%)' };
}

/* ── payloads ── */

/* Validate a decoded /api/stocks response and apply the same fallbacks the
   renderer uses (name ← symbol, currency ← 'USD'). Returns the normalized
   quote or null on a non-ok payload. Numeric fields may still be null —
   the fmt* helpers render those as em-dashes. */
export function readQuotePayload(data){
  if (!(data && data.ok)) return null;
  return {
    symbol: data.symbol,
    name: data.name || data.symbol,
    exchange: data.exchange || null,
    currency: data.currency || 'USD',
    price: data.price != null ? data.price : null,
    change: data.change != null ? data.change : null,
    changePct: data.changePct != null ? data.changePct : null,
    open: data.open != null ? data.open : null,
    high: data.high != null ? data.high : null,
    low: data.low != null ? data.low : null,
    prevClose: data.prevClose != null ? data.prevClose : null,
    marketCap: data.marketCap != null ? data.marketCap : null,   // currency millions
    weburl: data.weburl || null,
    ts: data.ts != null ? data.ts : null,                        // unix seconds
    delayed: !!data.delayed,
  };
}

/* Validate a decoded /api/stock-history response. Returns the points array
   ([[unixSeconds, close], …], ascending) or null. Fewer than 2 points can't
   draw a line, so that counts as "no history". */
export function readHistoryPayload(data){
  return (data && data.ok && Array.isArray(data.points) && data.points.length >= 2)
    ? data.points : null;
}

/* ── price-history chart math ──
   The endpoint returns the full daily series once per symbol; range
   switching just re-slices in the caller — no refetch. */

/* Chart ranges: [label, window in days]. */
export const RANGES = [['1M',30],['3M',91],['6M',182],['1Y',365],['5Y',1830]];

/* Slice the series to a range window ending "now". `nowSec` (unix seconds)
   is injectable for tests/replays and defaults to the current time; an
   unknown range label falls back to the 6-month window. A window with fewer
   than 2 points can't draw, so it degrades to the last two available. */
export function sliceSeries(series, range, nowSec){
  const s = series || [];
  const r = RANGES.find(x => x[0] === range);
  const cutoff = (nowSec != null ? nowSec : Date.now() / 1000) - (r ? r[1] : 182) * 86400;
  let pts = s.filter(p => p[0] >= cutoff);
  if (pts.length < 2) pts = s.slice(-Math.min(s.length, 2));            // window too short → last available
  return pts;
}

/* Scale points into a w×h viewBox and build the SVG path strings the chart
   draws: `line` for the stroke, `area` for the fill (the line closed down
   to the x-axis). The y-range is padded 8% so the line doesn't kiss the box
   edges, and a flat series gets a synthetic ±2% span so it still reads as a
   line rather than degenerating. `up` compares last close to first and
   drives the up/down coloring. Needs ≥2 points — returns null otherwise.
   Defaults match the site's viewBox (600×150). */
export function chartGeometry(pts, w, h){
  if (!pts || pts.length < 2) return null;
  const VW = w == null ? 600 : w, VH = h == null ? 150 : h;
  const xmin = pts[0][0], xmax = pts[pts.length - 1][0];
  let ymin = Infinity, ymax = -Infinity;
  for (const p of pts){ if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
  let span = ymax - ymin; if (span <= 0) span = Math.abs(ymax) * 0.02 || 1;
  ymin -= span * 0.08; ymax += span * 0.08;
  const xspan = (xmax - xmin) || 1, yspan = (ymax - ymin) || 1;
  const xs = pts.map(p => (p[0] - xmin) / xspan * VW);
  const Y = v => VH - (v - ymin) / yspan * VH;
  let d = '';
  for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + xs[i].toFixed(2) + ',' + Y(pts[i][1]).toFixed(2) + ' ';
  const area = d + 'L' + xs[xs.length - 1].toFixed(2) + ',' + VH + ' L' + xs[0].toFixed(2) + ',' + VH + ' Z';
  const up = pts[pts.length - 1][1] >= pts[0][1];
  return { xs, line: d.trim(), area, up };
}

/* Nearest sample to a viewBox x coordinate (the hover crosshair): binary
   search over the monotonic xs array, then pick the closer neighbour.
   `xs` must be non-empty (chartGeometry guarantees ≥2 entries). */
export function nearestIndex(xs, vx){
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1){ const mid = (lo + hi) >> 1; if (xs[mid] < vx) lo = mid; else hi = mid; }
  return (Math.abs(xs[lo] - vx) <= Math.abs(xs[hi] - vx)) ? lo : hi;
}
