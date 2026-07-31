# Reflow

Undo the hard line breaks that text picks up on the way out of a PDF or a
rendered web page. This is the logic of the
[Reflow tab on subnsub.com](https://subnsub.com), published so the seam rule
— the part that is easy to get wrong — is documented and reusable.

## Files

- [`reflow-text.js`](reflow-text.js) — the module: `reflow()`, `joinParagraph()`, `glue()`, `NO_SPACE_SCRIPT`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { reflow } from './reflow-text.js';

reflow('The quick brown\nfox jumps over.');
// → 'The quick brown fox jumps over.'

reflow('Para one\nwrapped here.\n\nPara two.');
// → 'Para one wrapped here.\n\nPara two.'

reflow('Para one\nwrapped.\n\nPara two.', { mode: 'one' });
// → 'Para one wrapped. Para two.'

reflow('这是一段从 PDF 里复制\n出来的中文。');
// → '这是一段从 PDF 里复制出来的中文。'   (no space — see below)

reflow('informa\ntion', { join: 'none' });
// → 'information'
```

Options: `mode` is `'para'` (default — blank lines stay paragraph breaks) or
`'one'` (everything becomes a single line); `join` is `'smart'` (default),
`'space'` or `'none'`.

## The seam rule

At every break the module decides what, if anything, replaces it:

- **`'space'`** — always a space. Correct for Latin scripts and wrong in the
  middle of a Chinese sentence.
- **`'none'`** — nothing at all.
- **`'smart'`** — a space, *except* in three cases:
  1. between two characters of a script that does not separate words with one
     (`NO_SPACE_SCRIPT`: Han including the planes past the BMP, kana,
     halfwidth kana, and the fullwidth / CJK punctuation that sits at a line
     edge);
  2. after a line-final connector — `well-` / `known` and folded URLs like
     `https://…/` / `path` have to close up;
  3. before punctuation that never takes a leading space (`,` `.` `;` `:`
     `!` `?` `%` `)` `]` `}` `»` `”` `’`).

Hangul is deliberately **not** in the no-space set: Korean spaces its words
the way Latin does, so a Korean line break wants the space and dropping it
would be a real error — the counter-example that makes "CJK" the wrong
shorthand here.

## Model & boundaries

- `\r\n`, a lone `\r` and U+2028 normalise to `\n`. U+2029 is a *paragraph*
  separator, so it normalises to a blank line instead — collapsing it would
  drop the very boundary `'para'` mode exists to keep.
- Trailing horizontal whitespace comes off every line before anything else:
  it is residue of the wrap being undone, and left in place it would silently
  decide the `'smart'` test. The full Unicode set is matched (U+00A0, U+1680,
  U+2000–U+200A, U+202F, U+205F, U+3000), because PDF text runs use more than
  the ASCII space.
- The two characters either side of a seam are read as whole code points, so
  Han past the BMP classifies correctly rather than as half a surrogate pair.
- Within a paragraph, the **first** line keeps its leading whitespace (an
  authored indent) and continuation lines lose theirs (wrap residue).
- In `'para'` mode a run of blank lines collapses to a single blank line;
  in `'one'` mode blank lines disappear along with every other break.
- Line-level only: there is no hyphenation repair. `'smart'` closes the seam
  up, so `archi-` / `tectures` comes back as `archi-tectures` rather than
  `archi- tectures`, but the hyphen itself stays — nothing here can tell an
  authored `well-known` from a typesetter's split without a dictionary.
