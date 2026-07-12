/* JSON format / minify / validate. Core logic of the JSON Formatter tab
   on subnsub.com, kept in lockstep with the in-page version.

   JSON.parse is the validator — no hand-rolled grammar to drift out of
   sync with the platform. What the tool adds is error geometry: engines
   embed "… at position N" in SyntaxError messages, and that offset is
   turned into a 1-based line/column so a human can find the comma.
   Message wording varies by engine, and short inputs may get no
   position at all, so line/col are best-effort: null when the engine
   didn't say.

   Input is trimmed before parsing; reported positions are relative to
   the trimmed text, same as the tab. */

/* Derive { message, line, col } from a parse error against the exact
   string that was parsed. The "in JSON…" tail is dropped once the
   position is extracted — line/col already carry that information. */
function locate(v, e) {
  const m = e.message;
  const posMatch = m.match(/position (\d+)/i);
  if (posMatch) {
    const pos = parseInt(posMatch[1]);
    const before = v.slice(0, pos);
    const line = before.split('\n').length, col = before.length - before.lastIndexOf('\n');
    return { message: m.replace(/in JSON.*/, ''), line, col };
  }
  return { message: m, line: null, col: null };
}

/* Pretty-print. indent matches the tab's toggle: 2 (default) or 4.
   Parse failures throw the SyntaxError untouched — use validate() when
   line/col are wanted. */
export function format(text, indent = 2) {
  return JSON.stringify(JSON.parse(String(text).trim()), null, indent);
}

/* Minify — parse, then stringify with no whitespace. */
export function minify(text) {
  return JSON.stringify(JSON.parse(String(text).trim()));
}

/* Validate only. Returns { valid: true } or
   { valid: false, message, line, col } — line/col null when the engine
   reported no position. */
export function validate(text) {
  const v = String(text).trim();
  try {
    JSON.parse(v);
    return { valid: true };
  } catch (e) {
    return { valid: false, ...locate(v, e) };
  }
}
