/* Coin flip. Core logic of the Coin tool on subnsub.com, kept in lockstep
   with the in-page version. This module is the fairness-relevant part —
   on site it is wrapped in a 3D tumbling coin, custom face labels and a
   stats board, none of which touch the outcome (the flip is decided
   before the animation starts).

   One flip = one bit from crypto.getRandomValues. Bits come from a
   buffered pool: 64 random 32-bit words at a time, consumed a bit per
   flip, so a ×1000 batch costs a single getRandomValues call rather than
   a thousand. Each bit of a random word is independently fair — no
   modulo, no float rounding, nothing to bias. Encoding matches the site:
   0 = heads, 1 = tails.

   Stats mirror the on-site board: totals and percentages per side, the
   longest run and which side ran it, and a rolling history capped at the
   most recent 500 flips.

   Needs crypto.getRandomValues (all current browsers, Node 18+). */

/* Entropy pool. idx walks the word buffer, word/left hold the word being
   drained. Starts exhausted (idx = 64) so importing the module never
   touches the RNG — the first flip fills it lazily. */
const coinBitState = { buf: new Uint32Array(64), idx: 64, word: 0, left: 0 };

/* One fair bit: 0 = heads, 1 = tails. */
export function coinBit() {
  if (coinBitState.left === 0) {
    if (coinBitState.idx >= coinBitState.buf.length) {
      crypto.getRandomValues(coinBitState.buf);
      coinBitState.idx = 0;
    }
    coinBitState.word = coinBitState.buf[coinBitState.idx++];
    coinBitState.left = 32;
  }
  const b = coinBitState.word & 1;
  coinBitState.word >>>= 1;
  coinBitState.left--;
  return b;
}

/* Flip n coins at once — the on-site ×1…×1000 batch buttons. Returns an
   array of bits in flip order. */
export function coinFlipBatch(n) {
  const results = new Array(n);
  for (let i = 0; i < n; i++) results[i] = coinBit();
  return results;
}

/* Fresh stats accumulator, shaped like the on-site coinStats object.
   _runSide/_runLen track the run in progress so longest-streak detection
   is O(1) per flip. The site's "clear" button is equivalent to swapping
   in a new one of these. */
export function createCoinStats() {
  return { total: 0, heads: 0, tails: 0, history: [], longest: 0, longestSide: null, _runSide: null, _runLen: 0 };
}

/* Record one result into stats. History keeps only the most recent 500
   flips; totals and streaks keep counting past that. */
export function coinPushFlip(stats, result) {
  stats.total++;
  if (result === 0) stats.heads++; else stats.tails++;
  if (stats._runSide === result) stats._runLen++;
  else { stats._runSide = result; stats._runLen = 1; }
  if (stats._runLen > stats.longest) {
    stats.longest = stats._runLen;
    stats.longestSide = result;
  }
  stats.history.push(result);
  if (stats.history.length > 500)
    stats.history.splice(0, stats.history.length - 500);
}

/* Percentage formatted the way the stats board shows it ('—' before any
   flips, one decimal place after). */
export function coinPct(num, den) { return den ? (num * 100 / den).toFixed(1) + '%' : '—'; }
