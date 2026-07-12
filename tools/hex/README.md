# Hex Converter

Text to hex bytes and back, entirely in the browser — the core logic of
the Hex tab on [subnsub.com](https://subnsub.com), published so the
conversion the site runs on your text is auditable.

## Files

- [`hex-codec.js`](hex-codec.js) — the module: `encode()`, `decode()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { encode, decode } from './hex-codec.js';

encode('Hé!');            // '48 c3 a9 21'         (UTF-8 bytes)
encode('Hé!', 'none');    // '48c3a921'
encode('Hé!', '0x');      // '0x48 0xc3 0xa9 0x21'
encode('Hé!', 'colon');   // '48:c3:a9:21'

decode('0x48 0x65, 6c:6c 6f');  // 'Hello' — separators stripped freely
```

`decode()` throws an `Error` with a `code` telling you what was wrong:
`'chars'` (non-hex characters left over), `'empty'` (nothing but
separators), `'odd'` (an odd number of hex digits).

## Notes

- Encoding is UTF-8 via `TextEncoder`, one zero-padded lowercase pair
  per byte; the separator argument matches the tab's toggle
  (`'space'` default, `'none'`, `'0x'`, `'colon'`).
- Decoding is deliberately forgiving about presentation: `0x` prefixes,
  whitespace, colons and commas are stripped wherever they appear, so
  dumps copied from debuggers, C arrays or `xxd` paste straight in.
- Decoded bytes go through `TextDecoder` in its default non-fatal mode:
  sequences that are not valid UTF-8 come back as U+FFFD replacement
  characters rather than an error.
