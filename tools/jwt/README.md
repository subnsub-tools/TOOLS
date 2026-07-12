# JWT Decoder & Verifier

Decode a JWT and verify its signature locally with WebCrypto — no token,
secret or key ever leaves the browser. This is the core logic of the
[JWT Decoder & Verifier tab on subnsub.com](https://subnsub.com), published
so the "verified locally" claim is auditable.

## Files

- [`jwt-verify.js`](jwt-verify.js) — the module: `decodeJwt()`,
  `jwtAlgInfo()`, `jwtVerify()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { decodeJwt, jwtAlgInfo, jwtVerify } from './jwt-verify.js';

const { header, payload, signature } = decodeJwt(token);
// throws: 'Not a valid JWT — expected 3 dot-separated parts', or the
// base64url/JSON error for a segment that does not decode

jwtAlgInfo(header.alg);
// → { kind:'hs'|'rs'|'ps'|'es', bits:'256'|'384'|'512', alg:'HS256' }
//   | { kind:'none', alg:'none' } | { kind:'unsupported', alg } | null

const r = await jwtVerify(token, header, keyText);
// r.ok === true   signature verified            (r.label 'Valid')
// r.ok === false  failed — reason in r.detail   ('Invalid', 'No alg', …)
// r.ok === null   indeterminate: no key supplied yet ('Awaiting key'),
//                 or alg="none" (r.kind === 'unsigned')
```

`keyText` is the raw shared secret for HS\*, or an SPKI
`-----BEGIN PUBLIC KEY-----` PEM for RS\*/PS\*/ES\*.

Requires a secure context (HTTPS or localhost) — `crypto.subtle` does not
exist elsewhere. Decoding alone has no such requirement.

## Model and boundaries

- Supported algorithms are exactly what WebCrypto implements natively:
  HS256/384/512, RS256/384/512, PS256/384/512 (salt length = hash length),
  and ES256/384/512 — ES512 on curve **P-521** per RFC 7518 §3.4. Anything
  else (EdDSA, RS1, …) reports `Unsupported` rather than guessing.
- `alg:"none"` is reported as **Unsigned** — an indeterminate warning
  state, deliberately distinct from `Valid`, because such a token is
  well-formed but proves nothing. A `none` header that still carries a
  signature segment is flagged as malformed.
- Verification checks the signature only. Claim validation (`exp`, `nbf`,
  `aud`, issuer trust) is presentation/policy and stays with the caller —
  the decoded payload gives you the claims to check.
- Decoding is intentionally permissive about content (any JSON header and
  payload) and strict about shape (exactly three segments). Payload text is
  decoded as UTF-8.
