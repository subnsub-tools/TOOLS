# QR Code

Generate QR codes from any text entirely in the browser — a from-scratch
byte-mode ISO/IEC 18004 encoder that emits a plain SVG string. This is the
core logic of the [QR Code tab on subnsub.com](https://subnsub.com) (and its
standalone `/qr` page), published so the "your text never leaves your device"
claim is auditable; the site's LAN-pairing widget renders its codes through
this same encoder.

## Files

- [`qr-encode.js`](qr-encode.js) — the module: `encode()`, `toSvg()`, `qrSvg()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { encode, toSvg, qrSvg } from './qr-encode.js';

// One step: text → '<svg …>…</svg>' (this is the site's window.QRCodeSVG)
const svg = qrSvg('otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP', {
  level: 'M',       // 'L' | 'M' | 'Q' | 'H'  (default 'M')
  moduleSize: 10,   // px per module          (default 10)
  margin: 4,        // quiet-zone modules     (default 4)
  fg: '#000', bg: '#fff',
});

// Or in two steps, if you want the raw symbol
const qr = encode('hello', 'Q');
// → { matrix, size, version, mask, level } — matrix[y][x] === 1 is a dark module
toSvg(qr, { margin: 0 });
```

`encode()` throws `Invalid ECC level` for an unknown level and
`Data too long for QR` when the input outgrows version 40 (≈2.9 KB of UTF-8
at level L; less at higher ECC levels).

## Model & boundaries

- **Byte mode only.** Input is UTF-8 encoded and stored as 8-bit codewords —
  no numeric/alphanumeric/kanji segmentation, so scanners hand back exactly
  the bytes that went in. Symbols can be a version larger than a
  segmenting encoder would produce for digit-only payloads; in exchange the
  encoding is trivially predictable.
- Versions 1–40, smallest fit chosen automatically. Reed-Solomon ECC over
  GF(256) (polynomial 0x11d), block split and interleave per the spec
  tables, all eight masks scored with the four ISO penalty rules, and
  format/version words BCH-protected.
- Output is a self-contained `<svg>` string (one `<path>` for all dark
  modules, `shape-rendering="crispEdges"`); the module never touches the
  DOM or the network.
- **Encoding only.** The site's QR *scanning* surfaces (e.g. the Transfer
  tool's "Scan QR") use the third-party [jsQR](https://github.com/cozmo/jsQR)
  library (MIT), vendored on the site and not part of this repository —
  everything in this module is our own encoder.
