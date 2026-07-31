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
- **`'smart'`** — a space, *except* in five cases:
  1. between two characters of a script that does not separate words with one
     (`NO_SPACE_SCRIPT`: Han across every plane out to extension H, kana,
     halfwidth kana, and the fullwidth / CJK punctuation that sits at a line
     edge);
  2. after a line-final connector — `well-` / `known` and folded URLs like
     `https://…/` / `path` have to close up;
  3. after opening punctuation (`(` `[` `{` `«` `“` `‘` and the CJK/fullwidth
     equivalents) or before closing punctuation (`,` `.` `;` `:` `!` `?` `%`
     `)` `]` `}` `»` `”` `’` `…` and theirs). The fullwidth ones are listed
     even though they are inside `NO_SPACE_SCRIPT`: that test only fires when
     **both** sides match, so `ABC` / `，` would otherwise gain a space;
  4. on URL punctuation (`?` `&` `=` `#` `%` …) **when the line actually ends
     inside a URL** — a bare `?` ending a line is a sentence, and gluing there
     would be wrong, so the check walks back to the last space and looks for a
     scheme;
  5. between a Han character and an ASCII/fullwidth digit: `第2章` and `2026年`
     had no space in the source, so putting one back is a visible error. Latin
     *letters* go the other way — `使用 Python` is the house style for mixed
     CJK text, and that spacing is kept.

Hangul is deliberately **not** in the no-space set: Korean spaces its words
the way Latin does, so a Korean line break wants the space and dropping it
would be a real error — the counter-example that makes "CJK" the wrong
shorthand here.

## Model & boundaries

- `\r\n`, a lone `\r`, U+0085 NEXT LINE and U+2028 normalise to `\n`. U+2029
  is a *paragraph* separator, so it normalises to a blank line instead —
  collapsing it would drop the very boundary `'para'` mode exists to keep.
- Linear in the input, deliberately. The trims walk the ends by hand rather
  than run `/[whitespace]+$/`, which backtracks from every position (3s on 40k
  trailing spaces), and the join tracks the tail piece separately instead of
  re-reading the accumulated string (18s on 160k lines). Both matter because
  the on-site tab re-runs this on every keystroke.
- Trailing horizontal whitespace comes off every line before anything else:
  it is residue of the wrap being undone, and left in place it would silently
  decide the `'smart'` test. The full Unicode set is matched (U+00A0, U+1680,
  U+2000–U+200A, U+202F, U+205F, U+3000), because PDF text runs use more than
  the ASCII space.
- The two characters either side of a seam are read as whole code points, so
  Han past the BMP classifies correctly rather than as half a surrogate pair;
  variation selectors and ZWJ are skipped, so `漢` is what gets tested rather
  than the selector trailing it.
- Within a paragraph, the **first** line keeps its leading whitespace (an
  authored indent) and continuation lines lose theirs (wrap residue).
- In `'para'` mode a run of blank lines collapses to a single blank line;
  in `'one'` mode blank lines disappear along with every other break.
- Line-level only: there is no hyphenation repair. `'smart'` closes the seam
  up, so `archi-` / `tectures` comes back as `archi-tectures` rather than
  `archi- tectures`, but the hyphen itself stays — nothing here can tell an
  authored `well-known` from a typesetter's split without a dictionary.
