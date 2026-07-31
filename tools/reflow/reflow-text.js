/* Line-break cleanup for copied text. Logic of the Reflow tool on
   subnsub.com, kept in lockstep with the in-page version.

   Text copied out of a PDF or a rendered web page carries a hard break at
   the end of every *printed* line, so it arrives pre-wrapped to a column
   width that has nothing to do with where it is being pasted. Undoing that
   is one decision repeated at every break: is this a real paragraph
   boundary, and what — if anything — goes in the seam.

   The seam is the part worth stating. A blanket space is wrong in two
   different ways: between two characters of a script that does not separate
   words with one, and at a seam the typesetter opened inside a word (a
   hyphenated split, a folded URL) or before punctuation that never takes a
   leading space. */

/* Scripts that do not put a space between words: Han (including the planes
   past the BMP, which is what the /u flag and the \u{...} ranges are for),
   kana, halfwidth kana, and the fullwidth / CJK punctuation that tends to sit
   at a line edge. Deliberately excludes Hangul: Korean spaces its words the
   way Latin does, so the fullwidth range stops at U+FF9F — halfwidth kana are
   in, the halfwidth jamo at U+FFA0 and the syllables at U+AC00 are out. */
export const NO_SPACE_SCRIPT =
  /[\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF9F\uFFE0-\uFFE6\u{20000}-\u{3134A}]/u;

/* Horizontal whitespace, the full Unicode set of it — \s is unusable here
   because it would also match the \n we split on. U+00A0 is what a web page
   pads with, U+3000 what a CJK document uses, and the U+2000 block turns up
   in PDF text runs. U+2028/U+2029 are line breaks, not spaces, and are
   normalised away before any of this runs.
   NB: written as escapes on purpose — a literal U+2028/U+2029 inside a regex
   literal is a LineTerminator and would be a syntax error, and the invisible
   spaces here would not survive an edit. */
const WS = /[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/;
const TRAIL = new RegExp(WS.source + '$');
const LEAD = new RegExp('^' + WS.source);
/* A line ending in a connector is a word (or a URL) the typesetter split, so
   it has to close up rather than gain a space: `well-` / `known`, `…/` /
   `path`. */
const CONNECTOR = /[-\u2010\u2011\/]$/;
/* Punctuation that never takes a space before it, wherever the break fell. */
const CLOSING = /^[,.;:!?%)\]}\u00BB\u201D\u2019]/;

/* Read one whole character off each end, code point and all: slice() alone
   would hand back half a surrogate pair for anything past the BMP (Han
   extension B and up), and the script test would then miss. */
const lastCh = (s) => { const t = Array.from(s.slice(-2)); return t.length ? t[t.length - 1] : ''; };
const firstCh = (s) => { const t = Array.from(s.slice(0, 2)); return t.length ? t[0] : ''; };

/* What replaces the line break, given everything joined so far and the line
   about to be appended. `prev` rather than a single character so the test
   always sees the two characters that will actually end up adjacent.
   join: 'smart' (default) | 'space' | 'none'. */
export function glue(prev, next, join = 'smart') {
  if (join === 'none') return '';
  if (join === 'space') return ' ';
  const a = lastCh(prev), b = firstCh(next);
  if (!a || !b) return '';
  if (WS.test(a) || WS.test(b)) return '';            /* one is already there */
  if (CONNECTOR.test(a) || CLOSING.test(b)) return '';
  return NO_SPACE_SCRIPT.test(a) && NO_SPACE_SCRIPT.test(b) ? '' : ' ';
}

/* One paragraph's lines → one line. The first line keeps its leading
   whitespace (an authored indent); continuation lines lose theirs, because
   there it is wrap residue rather than anything the author typed. */
export function joinParagraph(lines, join = 'smart') {
  let out = lines[0] || '';
  for (let i = 1; i < lines.length; i++) {
    const next = lines[i].replace(LEAD, '');
    if (!next) continue;
    out += glue(out, next, join) + next;
  }
  return out;
}

/* Undo the hard wrapping.
     mode 'para' (default) — a blank line stays a paragraph break; only the
       breaks inside a paragraph are joined. Runs of blank lines collapse to
       a single one.
     mode 'one'            — every break goes, blank lines included; the
       result is a single line.
   CRLF and a lone CR are plain line breaks, and so is U+2028. U+2029 is a
   PARAGRAPH separator: collapsing it to a single \n would silently drop the
   very boundary 'para' mode exists to keep, so it becomes a blank line.
   Trailing whitespace then comes off every line — it is residue of the same
   wrap being undone, and left in place it would silently decide the 'smart'
   test (a space is already there → no space added). */
export function reflow(text, { mode = 'para', join = 'smart' } = {}) {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(TRAIL, ''));

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
