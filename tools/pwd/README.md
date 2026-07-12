# Password

Cryptographically random password generation, entirely in the browser. This
is the core logic of the [Password tab on subnsub.com](https://subnsub.com),
published so the uniformity claim — every character an unbiased draw from
the chosen alphabet — is auditable.

## Files

- [`password-gen.js`](password-gen.js) — the module: `generatePassword()`,
  `pwdRandomFromAlphabet()`, `pwdCharset()`, `pwdStrength()`, `PWD_SETS`,
  `PWD_AMBIG`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { generatePassword, pwdRandomFromAlphabet, pwdStrength } from './password-gen.js';

const { password, charset, strength } = generatePassword({
  length: 20,
  sets: ['lower', 'upper', 'digit', 'symbol'],
  excludeAmbiguous: true,          // drop 0 O 1 l I
});
// strength → { label: 'Very strong', bits: 128, level: 4 }

// or draw from any alphabet directly
const pin = pwdRandomFromAlphabet('0123456789', 6);
```

Throws `'Select at least one character set'` when `sets` is empty and
`'Unknown character set: …'` for keys outside `PWD_SETS`.

## Model & boundaries

- Randomness is `crypto.getRandomValues` with **rejection sampling**: 32-bit
  words at or above the largest multiple of the alphabet size are discarded,
  so `word % N` is exactly uniform — plain modulo would bias the low end of
  the alphabet. Words are drawn 64 at a time to amortise the RNG call.
- Character sets: `lower`, `upper`, `digit`, `symbol`
  (`!@#$%^&*()-_=+[]{};:,.<>/?`). The ambiguous-glyph filter removes
  `0 O 1 l I`.
- The strength meter is **capacity, not pattern analysis**:
  `bits = log2(alphabet size) × length`, bucketed at 40 / 60 / 90 into
  weak / fair / strong / very strong. It grades what this generator
  produced; it says nothing useful about human-chosen passwords.
- Length is a free parameter here; the on-site slider offers 6–64.
- Nothing is stored or transmitted — generation is a pure function of the
  options and the RNG.
