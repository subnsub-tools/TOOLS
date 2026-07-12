/* HTML entity encode / decode. Core logic of the HTML Entities tab on
   subnsub.com, kept in lockstep with the in-page version.

   Encoding has two levels, matching the tab's toggle:

     safe (default) — only the five characters that can change markup
                      meaning: & < > " '. The apostrophe goes out as
                      &#x27; because &apos; is XML-born and pre-HTML5
                      parsers never knew it.
     all            — the five above, plus every code point over U+007F
                      as a hex numeric reference, for markup that must
                      survive non-UTF-8 channels.

   Decoding delegates to the platform's HTML parser via a detached
   <textarea>: assigning innerHTML there parses in RCDATA context, which
   resolves every named, decimal and hex reference the browser knows — a
   table this module could never keep as complete — and can only ever
   yield text, never elements or script. The element is not attached to
   any page. This makes decode() the one function in the repo that needs
   a `document` (a browser, or a DOM shim under Node). */

/* The click-to-copy reference grid shown beside the tab. */
export const ENTITIES = [['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ["'", '&#x27;'], ['©', '&copy;'], ['®', '&reg;'], ['™', '&trade;'], ['€', '&euro;'], ['£', '&pound;'], ['¥', '&yen;'], ['…', '&hellip;'], ['—', '&mdash;'], ['–', '&ndash;'], ['←', '&larr;'], ['→', '&rarr;']];

/* Encode. all=false → safe chars only; all=true → also every
   non-ASCII code point, as &#x…;. */
export function encode(s, all = false) {
  const safeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
  if (!all) return s.replace(/[&<>"']/g, c => safeMap[c]);
  let out = '';
  for (const ch of s) {
    if (safeMap[ch]) out += safeMap[ch];
    else if (ch.codePointAt(0) > 127) out += `&#x${ch.codePointAt(0).toString(16)};`;
    else out += ch;
  }
  return out;
}

/* Decode any entity the browser understands. Requires a `document`. */
export function decode(s) {
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}
