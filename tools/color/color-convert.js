/* Color parsing and conversion. Core logic of the Color tool on
   subnsub.com, kept in lockstep with the in-page version.

   Canonical form is 8-bit sRGB ({r,g,b} in 0–255): every input parses to
   that, every output derives from it. Accepted inputs: #rgb / #rrggbb
   (hash optional), rgb()/rgba() with comma-separated integers, and
   hsl()/hsla() with comma-separated integers. The modern space-separated
   CSS syntax is out of scope on purpose — the tool targets the classic
   forms people actually paste. Components are taken as written, not
   clamped, and alpha is ignored.

   Outputs are display-rounded the way the site shows them: HSL to whole
   numbers, OKLCH lightness/chroma to 3 decimals and hue to whole degrees.
   Round-tripping through those rounded values can drift by a unit — they
   are for reading, not archival precision. OKLCH goes through the
   reference sRGB → OKLab matrices (Björn Ottosson's constants). */

export function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16); if (isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; } else {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToRgb({ h, s, l }) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const h2r = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < .5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(h2r(p, q, h + 1 / 3) * 255),
    g: Math.round(h2r(p, q, h) * 255),
    b: Math.round(h2r(p, q, h - 1 / 3) * 255),
  };
}

export function rgbToOklch({ r, g, b }) {
  // sRGB → linear
  const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  // linear sRGB → OKLab
  const l = Math.cbrt(.4122214708 * lr + .5363325363 * lg + .0514459929 * lb);
  const m = Math.cbrt(.2119034982 * lr + .6806995451 * lg + .1073969566 * lb);
  const s = Math.cbrt(.0883024619 * lr + .2817188376 * lg + .6299787005 * lb);
  const L = .2104542553 * l + .7936177850 * m - .0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + .4505937099 * s;
  const bk = .0259040371 * l + .7827717662 * m - .8086757660 * s;
  const C = Math.sqrt(a * a + bk * bk);
  const H = (Math.atan2(bk, a) * 180 / Math.PI + 360) % 360;
  return { l: Math.round(L * 1000) / 1000, c: Math.round(C * 1000) / 1000, h: Math.round(H) };
}

/* Parse whatever the user typed into {r,g,b}, or null when it is not one
   of the recognised forms. hsl() input converts through hslToRgb, so the
   returned channels are already rounded to integers. */
export function parseColor(inp) {
  inp = inp.trim();
  // HEX
  if (/^#?[0-9a-fA-F]{3}$/.test(inp) || /^#?[0-9a-fA-F]{6}$/.test(inp)) {
    const rgb = hexToRgb(inp.startsWith('#') ? inp : '#' + inp); if (rgb) return rgb;
  }
  // rgb()
  const rm = inp.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rm) return { r: +rm[1], g: +rm[2], b: +rm[3] };
  // hsl()
  const hm = inp.match(/^hsla?\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?/);
  if (hm) return hslToRgb({ h: +hm[1], s: +hm[2], l: +hm[3] });
  return null;
}

/* One-call flow matching the on-site card: parse, then derive every output
   representation. Returns null for unrecognised input, otherwise
   { rgb, hsl, oklch, formats } where formats holds the exact display
   strings the tool shows. */
export function convertColor(input) {
  const rgb = parseColor(input);
  if (!rgb) return null;
  const hsl = rgbToHsl(rgb), hex = rgbToHex(rgb), oklch = rgbToOklch(rgb);
  const formats = {
    hex: hex,
    rgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    hsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
    oklch: `oklch(${oklch.l} ${oklch.c} ${oklch.h})`,
  };
  return { rgb, hsl, oklch, formats };
}
