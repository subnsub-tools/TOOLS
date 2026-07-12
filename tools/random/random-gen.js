/* Random number generation. Core logic of the Random tool on subnsub.com,
   kept in lockstep with the in-page version — the site adds a results
   card, stats line and histogram on top of these functions; none of that
   affects the draws.

   Every draw comes from crypto.getRandomValues with rejection sampling:
   raw words at or above the largest multiple of the range size are thrown
   away, so modulo never biases the result. Ranges up to 2^32 values use a
   single 32-bit word; wider ranges assemble a 64-bit value from 8 bytes
   and reject in BigInt space. Decimals are sampled on the integer lattice
   of the requested precision — rounding a continuous sample could emit
   values outside the bounds, the lattice cannot.

   Unique draws (no duplicates): ranges of ≤ 100 000 values are
   materialised and partially Fisher–Yates shuffled (O(count) swaps, no
   collisions to retry); wider ranges draw-and-reject against a Set, which
   stays fast because count is capped at 10 000 while the range is bigger
   than 100 000.

   Needs crypto.getRandomValues (all current browsers, Node 18+). */

/* Uniform integer in [lo, hi], both inclusive. */
export function rndIntInRange(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('Range must be finite');
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error('Range bounds must be integers in integer mode');
  if (hi < lo) throw new Error('Max must be ≥ min');
  const N = hi - lo + 1;
  if (N <= 0x100000000) {
    const limit = Math.floor(0x100000000 / N) * N;
    const buf = new Uint32Array(1);
    while (true) {
      crypto.getRandomValues(buf);
      if (buf[0] < limit) return lo + (buf[0] % N);
    }
  }
  const Nb = BigInt(N);
  const span = 1n << 64n;
  const limit = span - (span % Nb);
  const buf = new Uint8Array(8);
  while (true) {
    crypto.getRandomValues(buf);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[i]);
    if (v < limit) return lo + Number(v % Nb);
  }
}

/* Uniform float in [0, 1) with full 53-bit resolution — 27 high bits and
   26 low bits from two words, same construction the double format uses. */
export function rndUnit() {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const hi = buf[0] >>> 5, lo = buf[1] >>> 6;
  return (hi * 0x4000000 + lo) / 0x20000000000000;
}

/* Uniform decimal in [lo, hi] at a fixed number of decimal places. */
export function rndDecInRange(lo, hi, decimals) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('Range must be finite');
  if (hi < lo) throw new Error('Max must be ≥ min');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) throw new Error('Decimals must be 0..15');
  // Sample uniformly over the lattice of values that survive the requested
  // precision: rounding a continuous [lo, hi] sample can produce values
  // outside the stated bounds (e.g. min 0.6 / max 0.7 / 0 dp would round
  // to 1). Picking a quantized integer in [⌈lo·m⌉, ⌊hi·m⌋] keeps every
  // emitted value inside the inclusive range.
  const m = Math.pow(10, decimals);
  const loQ = Math.ceil(lo * m);
  const hiQ = Math.floor(hi * m);
  if (loQ > hiQ) throw new Error(`No ${decimals}-decimal values in [${lo}, ${hi}]`);
  return rndIntInRange(loQ, hiQ) / m;
}

/* Draw a whole batch.
     opts = { mode: 'int'|'dec', lo, hi, count, decimals, unique, sort }
   unique only applies to integer mode; sort is 'asc' | 'desc' | anything
   else for draw order. Returns an array of numbers. */
export function rndGenerateBatch(opts) {
  const { mode, lo, hi, count, decimals, unique, sort } = opts;
  if (!Number.isFinite(count) || count < 1 || count > 10000)
    throw new Error('Count must be between 1 and 10,000');
  let out;
  if (unique) {
    if (mode === 'dec') throw new Error('No duplicates only applies to integer mode');
    const N = hi - lo + 1;
    if (!Number.isInteger(N) || N < 1) throw new Error('Invalid range');
    if (count > N) throw new Error(`Can't draw ${count} unique values from ${N} possibilities`);
    if (N <= 100000) {
      const arr = new Array(N);
      for (let i = 0; i < N; i++) arr[i] = lo + i;
      for (let i = 0; i < count; i++) {
        const j = i + rndIntInRange(0, N - 1 - i);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      out = arr.slice(0, count);
    } else {
      const seen = new Set();
      out = [];
      while (out.length < count) {
        const v = rndIntInRange(lo, hi);
        if (!seen.has(v)) { seen.add(v); out.push(v); }
      }
    }
  } else {
    out = new Array(count);
    if (mode === 'int') for (let i = 0; i < count; i++) out[i] = rndIntInRange(lo, hi);
    else for (let i = 0; i < count; i++) out[i] = rndDecInRange(lo, hi, decimals);
  }
  if (sort === 'asc') out.sort((a, b) => a - b);
  if (sort === 'desc') out.sort((a, b) => b - a);
  return out;
}

/* Count field behaviour: whatever is typed is folded back into 1..10,000. */
export function rndClampCount(v) {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(10000, v));
}

/* Bound parsing. Accepts _ and , as digit separators; in integer mode a
   fractional value is rejected (NaN) rather than silently truncated. */
export function rndParseNumber(s, isInt) {
  const t = String(s).trim().replace(/_/g, '').replace(/,/g, '');
  if (t === '' || t === '-' || t === '+') return NaN;
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  if (isInt && !Number.isInteger(n)) return NaN;
  return n;
}

/* Output separators offered by the tool. Unknown values fall back to
   newline, matching the on-site default. */
export function rndFormatList(values, sep) {
  if (sep === 'newline') return values.join('\n');
  if (sep === 'comma') return values.join(', ');
  if (sep === 'space') return values.join(' ');
  if (sep === 'json') return JSON.stringify(values);
  if (sep === 'csv') return values.join(',');
  return values.join('\n');
}

/* The on-site Generate flow with the DOM peeled off: parse the min/max/
   count fields, validate, then draw. min/max/count may be strings exactly
   as typed. The MAX_SAFE_INTEGER guard matters: past 2^53 the range size
   itself is no longer exact, so uniformity could not be promised. */
export function rndGenerate({ mode = 'int', min, max, count = 1, decimals = 2, unique = false, sort = 'none' } = {}) {
  const isInt = mode === 'int';
  const lo = rndParseNumber(min, isInt);
  const hi = rndParseNumber(max, isInt);
  const n = rndClampCount(count);
  if (Number.isNaN(lo)) throw new Error('Min is not a valid number');
  if (Number.isNaN(hi)) throw new Error('Max is not a valid number');
  if (hi < lo) throw new Error('Max must be ≥ min');
  if (isInt && (hi - lo + 1) > Number.MAX_SAFE_INTEGER) throw new Error('Range too large');
  return rndGenerateBatch({ mode, lo, hi, count: n, decimals, unique, sort });
}
