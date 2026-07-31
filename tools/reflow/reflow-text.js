/* Line-break cleanup for copied text. Logic of the Reflow tool on
   subnsub.com, kept in lockstep with the in-page version.

   Text copied out of a PDF or a rendered web page carries a hard break at
   the end of every *printed* line, so it arrives pre-wrapped to a column
   width that has nothing to do with where it is being pasted. Undoing that
   is one decision repeated at every break: is this a real paragraph
   boundary, and what — if anything — goes in the seam.

   The seam is the part worth stating. A blanket space is wrong in several
   different ways: between two characters of a script that does not separate
   words with one, at a seam the typesetter opened inside a word or a URL,
   and around punctuation that never takes a space on one of its sides. */

/* Scripts that do not put a space between words: Han (every plane, out to
   extension H — that is what the /u flag and the \u{...} range are for),
   kana, halfwidth kana, and the fullwidth / CJK punctuation that tends to sit
   at a line edge. Deliberately excludes Hangul: Korean spaces its words the
   way Latin does, so the fullwidth range stops at U+FF9F — halfwidth kana are
   in, the halfwidth jamo at U+FFA0 and the syllables at U+AC00 are out. */
export const NO_SPACE_SCRIPT = /[\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF9F\uFFE0-\uFFE6\u{20000}-\u{323AF}]/u;
/* ONE horizontal-whitespace character. The quantified anchored form this used
   to be — /[ws]+$/ — retries from every position when a long run of spaces is
   followed by anything else (10k spaces took 185ms, 40k took 3s). The trims
   below walk the ends instead. \s is unusable either way: it would match the
   \n we split on. Written as escapes on purpose — a literal U+2028/U+2029 in
   a regex literal is a LineTerminator and a syntax error, and the invisible
   spaces would not survive an edit. */
const WS = /[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;
/* Variation selectors and ZWJ ride BEHIND the character they modify, so the
   last code point of a line is not necessarily the one to classify. */
const MOD = /[\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
/* A line ending in a connector is a word (or a URL) the typesetter split, so
   it has to close up rather than gain a space: `well-` / `known`, `…/` /
   `path`. */
const CONNECTOR = /[-\u2010\u2011\/]$/;
/* URL punctuation joins tight too, but ONLY inside a URL — a bare `?` at the
   end of a line is a sentence, and gluing there would be wrong. */
const URL_PUNCT = /[?&=#%~+_.,;:!]$/;
/* Punctuation that never takes a space after it (opening) or before it
   (closing), in both the ASCII and the CJK/fullwidth flavours. The fullwidth
   ones need naming here even though they are inside NO_SPACE_SCRIPT: that
   test only fires when BOTH sides match, and `ABC` / `，` is the case it
   misses. */
const OPENING = /[([{\u00AB\u201C\u2018\u3008\u300A\u300C\u300E\u3010\u3014\uFF08\uFF3B\uFF5B]$/;
const CLOSING = /^[,.;:!?%)\]}\u00BB\u201D\u2019\u2026\u3001\u3002\u3009\u300B\u300D\u300F\u3011\u3015\uFF01\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF3D\uFF5D]/;
const DIGIT = /[0-9\uFF10-\uFF19]/;

/* Linear end trims — see the WS note. */
function trimEnd(s) { let i = s.length; while (i > 0 && WS.test(s.charAt(i - 1))) i--; return i === s.length ? s : s.slice(0, i); }
function trimStart(s) { let i = 0; const n = s.length; while (i < n && WS.test(s.charAt(i))) i++; return i ? s.slice(i) : s; }

/* Read the character to classify off each end: whole code points (slice()
   alone hands back half a surrogate pair for anything past the BMP), and
   skipping past any modifiers so `漢` is tested rather than the variation
   selector trailing it. */
function lastCh(s) {
  const t = Array.from(s.slice(-12));
  for (let i = t.length - 1; i >= 0; i--) if (!MOD.test(t[i])) return t[i];
  return '';
}
function firstCh(s) { const t = Array.from(s.slice(0, 4)); return t.length ? t[0] : ''; }
/* Does this line end inside a URL? Walk back to the last space and look for a
   scheme. Bounded on purpose — a pathological line with no spaces at all must
   not make this quadratic. */
function endsInUrl(s) {
  const from = Math.max(0, s.length - 2048);
  let i = s.length;
  while (i > from && !WS.test(s.charAt(i - 1))) i--;
  const tok = s.slice(i);
  return tok.indexOf('://') > 0 || tok.lastIndexOf('www.', 0) === 0;
}

/* What replaces the line break. `prev` is the piece already joined
   immediately before `next`, so the test always sees the two characters that
   will actually end up adjacent.
   join: 'smart' (default) | 'space' | 'none'. */
export function glue(prev, next, join = 'smart') {
  if (join === 'none') return '';
  if (join === 'space') return ' ';
  const a = lastCh(prev), b = firstCh(next);
  if (!a || !b) return '';
  if (WS.test(a) || WS.test(b)) return '';            /* one is already there */
  if (CONNECTOR.test(a) || OPENING.test(a) || CLOSING.test(b)) return '';
  if (URL_PUNCT.test(a) && endsInUrl(prev)) return '';
  const ha = NO_SPACE_SCRIPT.test(a), hb = NO_SPACE_SCRIPT.test(b);
  if (ha && hb) return '';
  /* A digit against a Han character had no space in the source either —
     `第2章`, `2026年` — so putting one back is a visible error. Latin letters
     are the other way round: `使用 Python` is the house style for mixed CJK
     text, and that spacing is worth keeping. */
  if ((ha && DIGIT.test(b)) || (hb && DIGIT.test(a))) return '';
  return ' ';
}

/* One paragraph's lines → one line. The first line keeps its leading
   whitespace (an authored indent); continuation lines lose theirs, because
   there it is wrap residue rather than anything the author typed.
   Only the tail piece is ever tested, so it is tracked separately: handing
   lastCh() the whole accumulated string forces a rope flatten per line and
   turns this quadratic (18s at 160k lines before the split). */
export function joinParagraph(lines, join = 'smart') {
  const parts = [lines[0] || ''];
  let tail = parts[0];
  for (let i = 1; i < lines.length; i++) {
    const next = trimStart(lines[i]);
    if (!next) continue;
    parts.push(glue(tail, next, join), next);
    tail = next;
  }
  return parts.join('');
}

/* Undo the hard wrapping.
     mode 'para' (default) — a blank line stays a paragraph break; only the
       breaks inside a paragraph are joined. Runs of blank lines collapse to
       a single one.
     mode 'one'            — every break goes, blank lines included; the
       result is a single line.
   CRLF, a lone CR, U+0085 NEXT LINE and U+2028 are all plain line breaks.
   U+2029 is a PARAGRAPH separator: collapsing it to a single \n would
   silently drop the very boundary 'para' mode exists to keep, so it becomes a
   blank line. Trailing whitespace then comes off every line — it is residue
   of the same wrap being undone, and left in place it would silently decide
   the 'smart' test (a space is already there → no space added). */
export function reflow(text, { mode = 'para', join = 'smart' } = {}) {
  const lines = String(text)
    .replace(/\r\n?/g,'\n')
    .replace(/[\u0085\u2028]/g,'\n')
    .replace(/\u2029/g,'\n\n')
    .split('\n')
    .map(trimEnd);

  if (mode === 'one') return joinParagraph(lines.filter((l) => l !== ''), join);

  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(joinParagraph(para, join)); para = []; } };
  for (const l of lines) {
    if (l === '') flush(); else para.push(l);
  }
  flush();
  return out.join('\n\n');
}
