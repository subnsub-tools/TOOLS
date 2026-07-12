# UUID Generator

RFC 4122 version-4 UUIDs from cryptographically random bytes, plus the
inspector for pasted UUIDs — the core logic of the UUID tab on
[subnsub.com](https://subnsub.com), published so the randomness claim
("crypto-random, generated on your device") is auditable.

## Files

- [`uuid-gen.js`](uuid-gen.js) — the module: `genUuid()`, `inspectUuid()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { genUuid, inspectUuid } from './uuid-gen.js';

genUuid();  // '66d35084-c346-46ef-b813-65299e31f59a' (fresh each call)

inspectUuid('66d35084-c346-46ef-b813-65299e31f59a');
// { valid: true, version: 4 }
inspectUuid('2b4a0a58-3ca5-11ee-be56-0242ac120002');
// { valid: true, version: 1 }
inspectUuid('not-a-uuid');
// { valid: false }
```

## Notes

- Generation: sixteen bytes from `crypto.getRandomValues` (a CSPRNG —
  `Math.random` is never involved), then the two structural stamps of
  RFC 4122: version nibble `0100` in byte 6, variant bits `10` in
  byte 8. 122 random bits remain.
- `getRandomValues` rather than `crypto.randomUUID`: same generator,
  but without `randomUUID`'s secure-context gate.
- `inspectUuid` checks canonical hyphenated shape (either case),
  version digit 1–5 and the RFC variant nibble `[89ab]`. It validates
  *form*, not provenance — a well-shaped UUID says nothing about how
  random its source was. Versions: 1 time-based, 2 DCE security,
  3 MD5 name-based, 4 random, 5 SHA-1 name-based.
