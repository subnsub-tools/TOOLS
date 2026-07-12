# Random

Uniform random numbers — integers, fixed-precision decimals, no-duplicate
draws — from `crypto.getRandomValues`. This is the core logic of the
[Random tab on subnsub.com](https://subnsub.com), published so the
uniformity claims are auditable: the site's results card, stats line and
histogram are a display layer over exactly these functions.

## Files

- [`random-gen.js`](random-gen.js) — the module: `rndGenerate()`,
  `rndGenerateBatch()`, `rndIntInRange()`, `rndDecInRange()`, `rndUnit()`,
  `rndParseNumber()`, `rndClampCount()`, `rndFormatList()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { rndGenerate, rndIntInRange, rndUnit, rndFormatList } from './random-gen.js';

// the on-site Generate flow: field strings in, validated numbers out
const values = rndGenerate({
  mode: 'int',            // or 'dec' (+ decimals: 0..15)
  min: '1', max: '49',
  count: 6,
  unique: true,           // integer mode only
  sort: 'asc',            // 'asc' | 'desc' | 'none'
});
rndFormatList(values, 'comma');   // also 'newline' | 'space' | 'json' | 'csv'

rndIntInRange(1, 6);   // uniform die roll, bounds inclusive
rndUnit();             // uniform float in [0, 1), 53-bit resolution
```

The on-site quick presets are just parameter bundles over the same call —
e.g. Lotto is `{min: 1, max: 49, count: 6, unique: true, sort: 'asc'}`.

## Model & boundaries

- Every draw is `crypto.getRandomValues` + **rejection sampling**: raw words
  at or above the largest multiple of the range size are discarded, so
  modulo never biases the result. Ranges up to 2³² values use one 32-bit
  word; wider ranges assemble a 64-bit value and reject in BigInt space.
- Decimals are sampled on the integer lattice of the requested precision
  (`⌈min·10^d⌉ … ⌊max·10^d⌋`), because rounding a continuous sample could
  emit values outside the stated bounds. A range that contains no lattice
  point (e.g. 0.6–0.7 at 0 decimals) is an error, not a silent stretch.
- No-duplicate draws: ranges of ≤ 100 000 values are materialised and
  partially Fisher–Yates shuffled; wider ranges draw-and-reject against a
  `Set` (fast because count ≤ 10 000 while the range is larger).
- Caps: count 1–10 000 (`rndGenerate` clamps the field value, the batch
  function throws); integer spans wider than `Number.MAX_SAFE_INTEGER` are
  rejected — past 2⁵³ the span itself is no longer exact, so uniformity
  could not be promised; decimals 0–15.
- Bound parsing (`rndParseNumber`) strips `_` and `,` as digit separators —
  `1,000` reads as one thousand, and a comma is never a decimal point. In
  integer mode a fractional bound is rejected rather than truncated.
