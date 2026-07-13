# Calc Pro

One box, Wolfram-style answers — exact fractions and huge integers, unit
conversion, number bases, date maths and closed forms, fully offline.
This is the core engine of the built-in **Calc Pro** tab on [subnsub.com](https://subnsub.com) and [200000.live](https://www.200000.live).

## Files

- [`calcpro-engine.js`](calcpro-engine.js) — the engine (UMD-lite: browser
  global `CalcPro`, or `require()` under node)

## Usage

```js
const CalcPro = require('./calcpro-engine.js');

CalcPro.evaluate('(3 km + 200 m) in ft');
// → { ok: true, kindOf: 'math', text: '10,498.687664042 ft', cards: [...], ans: {...} }

CalcPro.evaluate('ans + 8', { ans: previous.ans });   // chain results
CalcPro.evaluate('today + 90 days', { now: Date.now() });
```

`evaluate(src, opts)` returns either

- `{ ok: true, kindOf: 'math'|'date', text, cards, ans }` — `cards` is a
  render-ready list (`main` with exact/approx/note/full, `closed`, `base`
  with hex/dec/oct/bin rows, `units` with an also-equal-to table, `date`),
  `ans` is an opaque value to pass back for chaining; or
- `{ ok: false, kind: 'syntax'|'math', msg }` — `syntax` means the input
  is likely mid-typing (UIs should stay quiet), `math` is a real error
  (dimension mismatch, division by zero, …).

## What the engine does

- **Exact numeric tower** — BigInt rationals first (`1/3 + 1/6` → `0.5`
  exactly, `2^128` in full), automatic demotion to float past a bit-length
  budget, complex numbers where they arise (`sqrt(-4)` → `2i`).
- **Units** — 9-dimension vector algebra (SI + angle + data), `to`/`in`/`as`
  conversion, affine °C/°F, SI and binary prefixes, `5 in in cm` handled.
- **Bases & bitwise** — `0x`/`0b`/`0o` literals, `and or xor << >> ~`,
  `255 to hex`, BigInt-wide.
- **Dates** — `today + 90 days`, `2026-01-01 to today`, calendar-aware
  month/year steps with day clamping.
- **Percent conventions** — `20% of 149`, `149 + 10%` → `163.9`.
- **Closed-form detection** — floats are reverse-matched against π, √n,
  small rationals, e, φ, ln 2, ln 10 families (relative tolerance 1e-14)
  and surfaced as a "possible closed form" card.

## Conventions (deliberate choices)

- Implicit multiplication binds tighter than explicit `*`/`/`:
  `20 L / 100 km` is `(20 L)/(100 km)`, `1/2pi` is `1/(2π)`.
- `(-8)^(1/3)` gives the real root `-2` (consistent with `cbrt`), not the
  complex principal value; irrational exponents on negative bases do go
  complex.
- `mmHg` ≠ `torr`: `1 atm` is exactly `760 torr` and ≈ `759.9999 mmHg`.
- `-5 mod 3` is `1` (floored / sign-of-divisor).

## Guards

Expression length, AST depth, rational bit-length (~39k digits), factorial
(exact ≤ 10000!), integer-pow and shift sizes are all clamped so hostile
input (`9^9^9^9`, `1e400!`) returns fast instead of hanging the page.
