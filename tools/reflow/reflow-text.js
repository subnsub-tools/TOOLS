/* Line-break cleanup for copied text. Logic of the Reflow tool on
   subnsub.com, kept in lockstep with the in-page version.

   Text copied out of a PDF or a rendered web page carries a hard break at
   the end of every *printed* line, so it arrives pre-wrapped to a column
   width that has nothing to do with where it is being pasted. Undoing that
   is one decision repeated at every break: is this a real paragraph
   boundary, and what — if anything — goes in the seam.

   The seam is the part worth stating: a blanket space is wrong for the
   scripts that do not separate words with one. Han and kana get nothing;
   Hangul is NOT in that set, because Korean spaces its words like Latin
   does and a missing space there is a real error. */

/* Scripts that do not put a space between words. Deliberately excludes
   Hangul (U+AC00–U+D7AF and the Jamo blocks) — see the note above. */
export const NO_SPACE_SCRIPT =
  /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿︰-﹏＀-｠￠-￦]/;

/* Horizontal whitespace only — \s would also match the \n we split on.
   U+00A0 is what a web page pads with, U+3000 what a CJK document uses. */
const WS = /[ 	 　]+/;
const TRAIL = new RegExp(WS.source + '$');
const LEAD = new RegExp('^' + WS.source);

/* What replaces the line break, given everything joined so far and the line
   about to be appended. `prev` rather than a single character so the test
   always sees the two characters that will actually end up adjacent.
   join: 'smart' (default) | 'space' | 'none'. */
export function glue(prev, next, join = 'smart') {
  if (join === 'none') return '';
  if (join === 'space') return ' ';
  const a = prev.slice(-1), b = next.slice(0, 1);
  if (!a || !b) return '';
  if (WS.test(a) || WS.test(b)) return '';        /* one is already there */
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
   Trailing whitespace is stripped from every line first: it is residue of
   the same wrap being undone, and left in place it would silently decide
   the 'smart' test (a space is already there → no space added). */
export function reflow(text, { mode = 'para', join = 'smart' } = {}) {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')   /* line/paragraph separators paste in as breaks too */
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
