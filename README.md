# Core Tools

The core logic behind the built-in tools on
[subnsub.com](https://subnsub.com) — every tool tab that ships with the
site, published so the code that touches your data is auditable rather
than something you have to take on faith.

This is the sibling repository of
[community-tools](https://github.com/subnsub-tools/community-tools):
that one hosts the Community-tab tools (installable extras, including
community contributions); this one hosts the built-in set. Same idea in
both: each tool's logic lives here as a standalone dependency-free ES
module, with a minimal demo page, and the styled versions on subnsub.com
wrap these same algorithms — we keep the two in lockstep when tool logic
changes.

Not every built-in tool is a pure file processor, so this repo is honest
about shapes:

- **Client-only tools** (encoders, parsers, generators, crypto): the
  module here *is* the tool. Nothing leaves your device.
- **Data tools** (rates, quotes, weather, schedules): the module here is
  the full client-side logic — payload normalisation, math, rendering
  models. The site fetches source data through same-origin proxies; the
  payload shape each module consumes is documented in its README, and the
  modules themselves perform no network I/O.
- **Connected tools** (transfer, link sharing, clipboard slots): the
  module here is the client engine — protocols, chunking, orchestration.
  Server counterparts (storage, signalling, short-link minting) are not
  part of this repository; each README states the wire contract the
  client speaks.

## Tools

| Tool | Module | What it does |
|---|---|---|
| [TOTP](tools/totp/) | `totp.js` | TOTP/HOTP computation — Base32, `otpauth://` parsing, HMAC-SHA1/256/512 (RFC 4226/6238). |
| [QR](tools/qr/) | `qr-encode.js` | Byte-mode QR encoder, versions 1–40, ISO/IEC 18004 — emits plain SVG. |
| [Base64](tools/base64/) | `base64-codec.js` | UTF-8-safe Base64 encode/decode. |
| [URL](tools/url/) | `url-codec.js` | URL percent-encoding, both directions. |
| [Hex](tools/hex/) | `hex-codec.js` | Text ↔ hexadecimal. |
| [Base](tools/numbase/) | `base-convert.js` | Arbitrary-radix integer conversion. |
| [HTML](tools/html/) | `html-entities.js` | HTML entity encode/decode. |
| [JSON](tools/json/) | `json-format.js` | JSON format / validate / minify. |
| [YAML](tools/yaml/) | `yaml-convert.js` | YAML ↔ JSON, hand-rolled parser and emitter. |
| [Regex](tools/regex/) | `regex-test.js` | Regex evaluation core — matches, positions, capture groups. |
| [Diff](tools/diff/) | `text-diff.js` | Plain-text diff. |
| [JWT](tools/jwt/) | `jwt-verify.js` | JWT decode + WebCrypto signature verification. |
| [Hash](tools/hash/) | `hash-digest.js` | WebCrypto digests over text and files. |
| [Color](tools/color/) | `color-convert.js` | Color parsing and space conversion. |
| [UUID](tools/uuid/) | `uuid-gen.js` | UUID generation. |
| [Password](tools/pwd/) | `password-gen.js` | Crypto-random password generation. |
| [Random](tools/random/) | `random-gen.js` | Uniform crypto-random integers, floats, samples. |
| [Coin](tools/coin/) | `coin-flip.js` | Fair coin flip + streak bookkeeping. |
| [Timer](tools/timer/) | `timer-engine.js` | Timer / stopwatch / clock engine — drift-corrected, pause-safe. |
| [Unix](tools/unix/) | `unix-time.js` | Unix timestamp ↔ date conversion. |
| [Cron](tools/cron/) | `cron-parse.js` | Cron expression parser + next-run computation. |
| [Currency](tools/fx/) | `fx-convert.js` | Cross-rate math over a USD-base rate table. |
| [Stocks](tools/stocks/) | `stock-quotes.js` | Quote payload normalisation, change math, sparkline shaping. |
| [World Cup](tools/worldcup/) | `worldcup-schedule.js` | Schedule normalisation, group tables, kickoff time-zone handling. |
| [Weather](tools/weather/) | `weather-core.js` | Geocoding query strategy (CJK-aware) + weather-code mapping. |
| [Today](tools/today/) | `today-aggregate.js` | Pinned-tools aggregation model and scheduler. |
| [Speed](tools/speed/) | `speed-orchestrate.js` | Measurement orchestration + scoring around the speed-test engine. |
| [My IP](tools/myip/) | `ip-exposure.js` | Local-address probing + IP classification and exposure summary. |
| [Clipboard](tools/clipboard/) | `clipboard-core.js` | Clipboard interop layer — Safari-safe writes, guarded image decode. |
| [Link](tools/link/) | `link-upload.js` | Upload orchestration — batching, concurrency, retries, expiry model. |
| [Transfer](tools/lan/) | `lan-transfer.js` | WebRTC P2P file transfer — chunking, resume, streaming sink. |
| [Melody](tools/melody/) | `melody-core.js` | WebAudio synth, melody format, MIDI (SMF) import. |

Each directory is self-contained: one dependency-free module, one plain
demo page, one README. Open any `demo.html` over HTTP (ES modules don't
load from `file://`):

```
python3 -m http.server 8000
# → http://localhost:8000/tools/totp/demo.html
```

## What this repo is (and isn't)

- **It is the auditable core**: parsers, crypto, converters, protocol
  engines, and the guards around them.
- **It is not the site.** The UI shell, design system, i18n, accounts and
  server functions of subnsub.com are not part of this repository. The
  demo pages here are deliberately unstyled.
- Third-party engines the site vendors (jsQR for QR scanning,
  @cloudflare/speedtest for bandwidth measurement, pdf-lib, …) are not
  re-published here; each tool README declares what it builds on and
  under which license.

## Contributing

These are the site's built-in tools, so this repo doesn't run a
contribution pipeline — that lives in
[community-tools](https://github.com/subnsub-tools/community-tools),
where a merged module ends up as an installable tool credited to you.
Bug reports and security findings for anything here are very welcome
(see Issues, or private vulnerability reporting for security).

## License

[AGPL-3.0](LICENSE) © 2026 SUB&SUB LLC.

The AGPL is a deliberate choice: audit freely, fork freely — but a hosted
closed-source fork must publish its changes. "SUB&SUB", "subnsub" and the
site's visual identity are not licensed by this repository.
