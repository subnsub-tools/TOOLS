/* Currency converter — core math of the Currency (FX) tab on subnsub.com,
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
   picker and used for the quick-conversion tiles. Lowercased to match the
   API's key casing. */
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

/* Quick-conversion tile targets: the popular list minus the FROM side,
   restricted to codes the table actually quotes, first 8. */
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
