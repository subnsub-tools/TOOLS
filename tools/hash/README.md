# Hash

SHA-1 / SHA-256 / SHA-512 digests of text or files, computed entirely in the
browser via WebCrypto. This is the core logic of the
[Hash tab on subnsub.com](https://subnsub.com), published so the "your input
is hashed locally, never uploaded" claim is auditable.

## Files

- [`hash-digest.js`](hash-digest.js) — the module: `hashBytes()`, `ALGORITHMS`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { hashBytes } from './hash-digest.js';

const { sha1, sha256, sha512 } = await hashBytes('hello');
// each a lowercase hex string

// files: read the bytes first, then hash them the same way
const digests = await hashBytes(new Uint8Array(await file.arrayBuffer()));
```

Requires a secure context (HTTPS or localhost) — `crypto.subtle` does not
exist elsewhere.

## Model

- All hashing is `crypto.subtle.digest` — no hand-rolled implementations, so
  correctness (and constant-time behaviour) is the platform's.
- Strings are digested as their UTF-8 encoding.
- SHA-1 is included for interop with older checksum ecosystems; it is broken
  for collision resistance and should not gate anything security-relevant.
- Whole-buffer operation: the input must fit in memory. The on-site version
  hashes dropped files the same way (`file.arrayBuffer()` first).
