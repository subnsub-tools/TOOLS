# Base64

UTF-8-safe Base64 encoding and decoding, entirely in the browser — the
core logic of the Base64 tab on [subnsub.com](https://subnsub.com),
published so the conversion the site runs on your text is auditable.

## Files

- [`base64-codec.js`](base64-codec.js) — the module: `encode()`, `decode()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { encode, decode } from './base64-codec.js';

encode('héllo ✓');          // 'aMOpbGxvIOKckw=='
decode('aMOpbGxvIOKckw=='); // 'héllo ✓'
decode('aGVs\nbG8=');       // 'hello' — embedded whitespace is fine
```

Both directions throw on bad input: `encode()` when the string has no
UTF-8 form (lone surrogates — a `URIError`), `decode()` on characters
outside the Base64 alphabet or bad padding (`atob`'s `DOMException`)
and on bytes that are not well-formed UTF-8 (`URIError`).

## Notes

- The heavy lifting is the platform's own `btoa`/`atob`; the wrapper's
  value is the UTF-8 bridge — `btoa` alone throws on any character above
  U+00FF — plus whitespace tolerance on decode, so line-wrapped Base64
  pastes straight in.
- Standard alphabet with `=` padding (RFC 4648 §4), not the URL-safe
  variant.
