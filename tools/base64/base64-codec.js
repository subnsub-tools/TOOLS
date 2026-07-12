/* UTF-8-safe Base64. Core logic of the Base64 tab on subnsub.com, kept
   in lockstep with the in-page version.

   btoa/atob only speak Latin-1, so both directions cross the classic
   percent-encoding bridge: encodeURIComponent spells the string's UTF-8
   bytes as %XX escapes, unescape folds each escape into the single
   Latin-1 code unit btoa expects — mirrored on the way back.
   escape/unescape are deprecated-but-frozen in the spec, which is
   exactly what makes the idiom portable.

   Standard alphabet with = padding (RFC 4648 §4), not the URL-safe
   variant. Whitespace is stripped before decoding so line-wrapped
   Base64 (MIME bodies, key dumps) pastes straight in. */

/* Encode text → Base64. Throws URIError on strings that have no UTF-8
   form (lone surrogates). */
export function encode(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

/* Decode Base64 → text. Throws on characters outside the alphabet or
   bad padding (atob), and on bytes that are not well-formed UTF-8
   (decodeURIComponent). */
export function decode(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\s/g, ''))));
}
