# Coin

Fair coin flips — one bit of `crypto.getRandomValues` entropy per flip. This
is the core logic of the [Coin tab on subnsub.com](https://subnsub.com),
published so the fairness claim is auditable: the site's 3D tumbling coin,
custom face labels and stats board are presentation over exactly these
functions, and the outcome is decided before the animation starts.

## Files

- [`coin-flip.js`](coin-flip.js) — the module: `coinBit()`,
  `coinFlipBatch()`, `createCoinStats()`, `coinPushFlip()`, `coinPct()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { coinFlipBatch, createCoinStats, coinPushFlip, coinPct } from './coin-flip.js';

const stats = createCoinStats();
const results = coinFlipBatch(100);       // array of bits, 0 = heads, 1 = tails
for (const r of results) coinPushFlip(stats, r);

stats.total;                              // 100
coinPct(stats.heads, stats.total);        // e.g. '52.0%'
stats.longest, stats.longestSide;         // longest run and which side ran it
stats.history;                            // most recent flips, capped at 500
```

Resetting is just `stats = createCoinStats()` — the on-site clear button
does the equivalent.

## Model & boundaries

- One flip consumes one bit of a random 32-bit word. Every bit of a
  `getRandomValues` word is independently unbiased, so there is no modulo
  step and nothing to correct for — the flip is exactly fair.
- Bits come from a buffered pool of 64 words refilled on demand, so a
  ×1000 batch costs a single RNG call. The pool starts empty; importing
  the module never touches the RNG.
- Encoding matches the site: **0 = heads, 1 = tails**.
- Stats are pure bookkeeping: totals per side, longest streak (tracked in
  O(1) per flip), and a rolling history capped at the most recent 500
  flips — totals and streaks keep counting past the cap.
- Flips are independent; the stats board reports history, it does not (and
  cannot) predict the next flip.
