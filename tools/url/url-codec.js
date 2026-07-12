/* URL percent-encoding, both directions. Core logic of the URL
   Encoder / Decoder tab on subnsub.com, kept in lockstep with the
   in-page version.

   Two methods, matching the tab's toggle:

     'component' — encodeURIComponent / decodeURIComponent. Encodes
                   every reserved character; right for query values,
                   path segments, form fields.
     'full'      — encodeURI / decodeURI. Treats the input as a whole
                   URL: structural characters (:/?#[]@ and the
                   sub-delims) pass through on encode, and their %XX
                   escapes stay encoded on decode — the platform keeps
                   the round trip from changing what the URL means.

   Thin by design: the platform functions are the algorithm; the tool
   adds the mode split and honest errors. Both directions throw
   URIError — encode on lone surrogates, decode on malformed %XX
   sequences. */

export function encode(text, method = 'component') {
  return method === 'component' ? encodeURIComponent(text) : encodeURI(text);
}

export function decode(text, method = 'component') {
  return method === 'component' ? decodeURIComponent(text) : decodeURI(text);
}
