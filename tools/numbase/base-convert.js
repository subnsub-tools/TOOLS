/* Arbitrary-size integer base conversion. Core logic of the Number Base
   Converter tab on subnsub.com, kept in lockstep with the in-page
   version.

   BigInt does the math, so there is no 53-bit precision cliff — integers
   of any length convert exactly. Whitespace and _ digit separators are
   stripped first; a leading - is peeled off and re-applied because
   BigInt's 0x/0b/0o literal forms don't take a sign. Presentation
   matches the tab: hex uppercase, binary grouped into nibbles once it is
   longer than four digits.

   The info strip mirrors the tab too:
     bits   — binary length of the magnitude (1 for zero)
     bytes  — storage after rounding up to the common 8/16/32/64 widths
              (or the exact bit length past 64)
     signed — the two's-complement reading of that same bit pattern at
              the fitted width, for non-negative values up to 64 bits;
              for negative input it is simply the value (already
              signed), and null when it doesn't apply. */

const NB_FIELDS = [
  { key: 'dec', base: 10, chars: /[^0-9\-]/g },
  { key: 'hex', base: 16, chars: /[^0-9a-fA-F\-]/g },
  { key: 'bin', base: 2, chars: /[^01\-]/g },
  { key: 'oct', base: 8, chars: /[^0-7\-]/g },
];

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* Convert one field's raw text. base is the base it was typed in
   (2, 8, 10 or 16). Returns null for empty input (nothing to convert),
   else { dec, hex, bin, oct, bits, bytes, signed }. Throws with
   e.code 'char' on characters illegal for the base and 'empty' for a
   bare sign; BigInt's own SyntaxError (misplaced -, etc.) propagates
   as-is. The tab leaves the field being typed in untouched — here all
   four representations are returned and the caller picks. */
export function convert(input, base) {
  const src = NB_FIELDS.find(f => f.base === base);
  if (!src) throw new TypeError('base must be 2, 8, 10 or 16');
  const raw = String(input).replace(/[\s_]/g, '');
  if (!raw) return null;
  if (src.chars.test(raw)) throw fail('char', `Invalid character for base ${base}`);
  let val;
  const neg = raw.startsWith('-');
  const abs = neg ? raw.slice(1) : raw;
  if (!abs) throw fail('empty', 'Empty');
  if (src.base === 10) val = BigInt(neg ? '-' + abs : abs);
  else if (src.base === 16) val = neg ? -BigInt('0x' + abs) : BigInt('0x' + abs);
  else if (src.base === 2) val = neg ? -BigInt('0b' + abs) : BigInt('0b' + abs);
  else if (src.base === 8) val = neg ? -BigInt('0o' + abs) : BigInt('0o' + abs);

  const isNeg = val < 0n;
  const absVal = isNeg ? -val : val;
  const sign = isNeg ? '-' : '';

  const out = {};
  NB_FIELDS.forEach(f => {
    let s = absVal.toString(f.base);
    if (f.base === 16) s = s.toUpperCase();
    if (f.base === 2 && s.length > 4) s = s.replace(/\B(?=(\d{4})+(?!\d))/g, ' ');
    out[f.key] = sign + s;
  });

  const bits = absVal === 0n ? 1 : absVal.toString(2).length;
  const fitBits = bits <= 8 ? 8 : bits <= 16 ? 16 : bits <= 32 ? 32 : bits <= 64 ? 64 : bits;
  out.bits = bits;
  out.bytes = Math.ceil(fitBits / 8);
  if (!isNeg && fitBits <= 64) {
    const w = BigInt(fitBits);
    const half = 1n << (w - 1n);
    if (absVal >= half) out.signed = String(Number(absVal - (1n << w)));
    else out.signed = String(Number(absVal));
  } else {
    out.signed = isNeg ? String(val) : null;
  }
  return out;
}
