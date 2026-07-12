# TOTP / HOTP

One-time codes from a Base32 secret, computed entirely in the browser —
RFC 4226 (HOTP) and RFC 6238 (TOTP) over WebCrypto HMAC. This is the core
logic of the [TOTP / HOTP Generator tab on subnsub.com](https://subnsub.com),
published so the "your secret never leaves your device" claim is auditable.

## Files

- [`totp.js`](totp.js) — the module: `otpCodes()`, `genCode()`, `b32dec()`,
  `parseOtpAuth()`, `buildOtpAuth()`, `totpWindow()`, plus the input/option
  gates (`normalizeSecret()`, `normalizeConfig()`, `algoNorm()`,
  `algoCompact()`, `hmacSign()`)
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { otpCodes, parseOtpAuth, buildOtpAuth, totpWindow } from './totp.js';

// TOTP: codes for the current 30 s window, plus neighbours for clock skew
const r = await otpCodes('JBSWY3DPEHPK3PXP', {
  mode: 'totp', algorithm: 'SHA-1', digits: 6, period: 30,
});
// → { current:'123456', previous:'…', next:'…', counter: 58231941, remaining: 17.4 }

// HOTP: fixed counter instead of a time window (remaining is null)
await otpCodes('JBSWY3DPEHPK3PXP', { mode: 'hotp', counter: 5 });

// Import from an authenticator QR payload
const acc = parseOtpAuth('otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&digits=6');
// → { type, label, secret, issuer, algorithm:'SHA1', digits, period, counter }

// Export the other way (null until the secret passes the input gate)
buildOtpAuth({ secret: 'JBSWY3DPEHPK3PXP', mode: 'totp', period: 30 });
```

`otpCodes(secret, config, nowMs?)` takes an optional clock so callers can
compute codes for any instant; it defaults to `Date.now()`.

Requires a secure context (HTTPS or localhost) — `crypto.subtle` does not
exist elsewhere.

## Model and boundaries

- HOTP per RFC 4226: HMAC over the 8-byte big-endian counter, dynamic
  truncation, `mod 10^digits`. TOTP is the same with
  `counter = floor(unixTime / period)`.
- Supported surface matches real authenticator apps: SHA-1 / SHA-256 /
  SHA-512, 6–8 digits, 30 s or 60 s periods. Unrecognised options fall back
  to the RFC defaults (SHA-1, 6 digits, 30 s) rather than erroring.
- Secrets are Base32 per RFC 4648; whitespace and trailing `=` padding are
  tolerated, and the input gate demands at least 8 Base32 chars before any
  HMAC runs.
- `otpauth://` parsing follows the Google Authenticator conventions, not a
  strict URI grammar: query values are percent-decoded with `+` as space,
  and malformed escapes are kept verbatim instead of rejected, because QR
  payloads in the wild are sloppy.
- Everything is stateless and offline. Nothing is persisted; verification
  policy (how much clock skew to accept) is the caller's decision —
  `previous` / `next` exist so a ±1-step check is one comparison away.
