/* Text ↔ hexadecimal. Core logic of the Hex Converter tab on
   subnsub.com, kept in lockstep with the in-page version.

   Encoding is UTF-8 (TextEncoder): one zero-padded lowercase pair per
   byte, joined by the chosen separator. Decoding is deliberately
   forgiving about presentation — 0x prefixes, whitespace, colons and
   commas are stripped wherever they appear, so dumps copied from
   debuggers, C arrays or xxd output paste straight in; what must remain
   is an even count of pure hex digits. Decoded bytes go through
   TextDecoder in its default non-fatal mode, so sequences that are not
   valid UTF-8 come back with U+FFFD replacement characters rather than
   an error. */

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* Encode text → hex string. sep matches the tab's toggle:
     'space' (default) → '48 65'
     'none'            → '4865'
     '0x'              → '0x48 0x65'
     'colon'           → '48:65'  (also the fallback for unknown values) */
export function encode(text, sep = 'space') {
  const bytes = new TextEncoder().encode(text);
  const parts = Array.from(bytes).map(b => b.toString(16).padStart(2, '0'));
  if (sep === 'space') return parts.join(' ');
  if (sep === 'none') return parts.join('');
  if (sep === '0x') return parts.map(x => '0x' + x).join(' ');
  return parts.join(':');
}

/* Decode hex → text. Throws with e.code:
     'chars' — leftover characters that are not hex digits
     'empty' — nothing but separators
     'odd'   — an odd number of hex digits (half a byte) */
export function decode(hex) {
  const clean = hex.replace(/0x/gi, '').replace(/[\s:,]/g, '');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw fail('chars', 'Invalid hex characters');
  if (clean.length === 0) throw fail('empty', 'No hex digits found');
  if (clean.length % 2 !== 0) throw fail('odd', 'Odd number of hex characters');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}
