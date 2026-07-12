# Color

Parse a CSS color and read it back as HEX, RGB, HSL and OKLCH. This is the
core logic of the [Color tab on subnsub.com](https://subnsub.com), published
so the exact parsing rules and rounding behaviour are documented and
reusable.

## Files

- [`color-convert.js`](color-convert.js) — the module: `convertColor()`,
  `parseColor()`, `hexToRgb()`, `rgbToHex()`, `rgbToHsl()`, `hslToRgb()`,
  `rgbToOklch()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { convertColor, parseColor, rgbToOklch } from './color-convert.js';

const r = convertColor('#ff0000');
// r.rgb     → { r: 255, g: 0, b: 0 }
// r.hsl     → { h: 0, s: 100, l: 50 }
// r.oklch   → { l: 0.628, c: 0.258, h: 29 }
// r.formats → { hex: '#FF0000', rgb: 'rgb(255, 0, 0)',
//               hsl: 'hsl(0, 100%, 50%)', oklch: 'oklch(0.628 0.258 29)' }
// null when the input is not a recognised color

parseColor('hsl(120, 50%, 50%)');   // → { r: 64, g: 191, b: 64 }
rgbToOklch({ r: 127, g: 90, b: 240 });
```

## Model & boundaries

- Canonical form is 8-bit sRGB (`{r,g,b}` in 0–255); every input parses to
  that and every output derives from it.
- Accepted inputs: `#rgb` / `#rrggbb` (hash optional), `rgb()` / `rgba()`
  with comma-separated integers, `hsl()` / `hsla()` with comma-separated
  integers. Modern space-separated CSS syntax, named colors and percentages
  in `rgb()` are out of scope; alpha is ignored.
- Components are taken as written, not clamped — `rgb(300, 0, 0)` is passed
  through the way the on-site tool does.
- Display rounding matches the site: HSL to whole numbers, OKLCH
  lightness/chroma to 3 decimals, hues to whole degrees. Round-trips through
  those rounded values can drift by a unit; treat the strings as readouts,
  not archival precision.
- OKLCH conversion uses the reference sRGB → OKLab matrices.
