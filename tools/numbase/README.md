# Number Base Converter

Binary / octal / decimal / hexadecimal conversion for integers of any
size — the core logic of the Base tab on
[subnsub.com](https://subnsub.com), published so the math the site runs
on your numbers is auditable.

## Files

- [`base-convert.js`](base-convert.js) — the module: `convert()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { convert } from './base-convert.js';

convert('255', 10);
// {
//   dec: '255', hex: 'FF', bin: '1111 1111', oct: '377',
//   bits: 8, bytes: 1, signed: '-1'
// }

convert('ff', 16).dec;                     // '255' — case-insensitive
convert('1_000', 10).hex;                  // '3E8' — _ and spaces stripped
convert('-1010', 2).dec;                   // '-10'
convert('18446744073709551616', 10).bin;   // exact — no 53-bit cliff
convert('', 10);                           // null — nothing to convert
```

The second argument is the base the text was typed in: `2`, `8`, `10`
or `16`. Invalid digits throw an `Error` with `e.code === 'char'`; a
bare sign throws with `e.code === 'empty'`; anything else malformed
propagates `BigInt`'s own `SyntaxError`.

## Notes

- `BigInt` does the math, so integers of any length convert exactly.
- Presentation matches the tab: hex uppercase, binary grouped into
  nibbles once longer than four digits, sign carried through. The tab
  leaves the field you are typing in untouched; the module returns all
  four representations and the caller picks.
- The info strip: `bits` is the magnitude's binary length (1 for zero);
  `bytes` rounds up to the common 8/16/32/64-bit widths (exact bit
  count past 64); `signed` is the two's-complement reading of that same
  bit pattern at the fitted width — only computed for non-negative
  values up to 64 bits (`'255'` at 8 bits reads as `-1`). For negative
  input it is simply the value itself, and `null` where it doesn't
  apply.
