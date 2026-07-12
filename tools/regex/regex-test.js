/* Regex evaluation. Core logic of the Regex Tester tab on subnsub.com,
   kept in lockstep with the in-page version.

   The engine is the platform's own RegExp, so patterns behave exactly
   as they will in production JavaScript — which is the point of testing
   here. The pattern is compiled twice on purpose: first with the
   caller's exact flags, so an invalid pattern/flag combination throws
   the same SyntaxError the developer would ship; then with 'g' forced
   in (deduped through a Set), because matchAll refuses non-global
   patterns and the tool always collects every match.

   Matches come back as the platform's own match arrays, untouched:
   m[0] the match, m.index its offset, capture groups as m[1…]
   (undefined when a group didn't participate), named groups on
   m.groups. */

/* Run pattern against text. flags is a flag string ('gi', …); the tab
   exposes g/i/m/s and defaults to 'g'. Empty pattern or empty text
   yields [] — nothing to run. Throws SyntaxError on an invalid
   pattern or flag set. */
export function run(pattern, text, flags = 'g') {
  if (!pattern || !text) return [];
  new RegExp(pattern, flags); /* validation only — throws with the caller's exact flags */
  return [...text.matchAll(new RegExp(pattern, [...new Set([...flags, 'g'])].join('')))];
}
