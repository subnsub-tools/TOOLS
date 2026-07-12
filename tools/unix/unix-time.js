/* Unix timestamp ↔ date conversion. Core logic of the Unix Timestamp
   tab on subnsub.com, kept in lockstep with the in-page version.

   Timestamps are epoch seconds (the Unix convention); the ×1000/÷1000
   against JavaScript's millisecond Dates happens here so callers never
   juggle units. Formatting leans on the platform on purpose —
   toISOString for the canonical UTC form, toUTCString/toLocaleString
   for the context strip — so output matches what the runtime itself
   considers correct for the user's locale and zone.

   Boundaries are the platform's too: fractional and negative
   (pre-1970) seconds are fine, and timestamps beyond the ECMAScript
   Date range (±8.64e15 ms) make toISOString throw a RangeError. */

/* '42s ago' / 'in 3h' — compact relative time for a signed difference
   in seconds (positive = future). Buckets: s under a minute, m under an
   hour, h under a day, d beyond. */
export function relTime(diff) {
  const abs = Math.abs(diff), fut = diff > 0;
  let s;
  if (abs < 60) s = `${Math.round(abs)}s`;
  else if (abs < 3600) s = `${Math.round(abs / 60)}m`;
  else if (abs < 86400) s = `${Math.round(abs / 3600)}h`;
  else s = `${Math.round(abs / 86400)}d`;
  return fut ? `in ${s}` : `${s} ago`;
}

/* Timestamp field → 'YYYY-MM-DD HH:MM:SS.sss UTC'. Accepts whatever
   Number() accepts ('1714363200', '1.5e9', …). Returns null for empty
   or non-numeric input. */
export function timestampToDate(input) {
  const v = String(input).trim();
  if (!v) return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  return new Date(n * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

/* Date/time string → epoch seconds, floored. Accepts anything the Date
   constructor parses; the tab feeds it a datetime-local value, which
   the platform reads in the local zone. Returns null for empty or
   unparseable input. */
export function dateToTimestamp(input) {
  if (!input) return null;
  const ts = Math.floor(new Date(input).getTime() / 1000);
  return isNaN(ts) ? null : ts;
}

/* The context strip shown under both fields: the same instant as UTC,
   as local time, and relative to now. Returns null when ts is missing
   or NaN. The rel string goes stale by nature — the tab re-renders it
   every second. */
export function describeTimestamp(ts) {
  if (ts === null || ts === undefined || isNaN(ts)) return null;
  const d = new Date(ts * 1000);
  return {
    utc: d.toUTCString(),
    local: d.toLocaleString(),
    rel: relTime(ts - Date.now() / 1000),
  };
}
