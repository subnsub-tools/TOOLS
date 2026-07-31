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
- **`'smart'`** — a space, *except* between two characters of a script that
  does not separate words with one. `NO_SPACE_SCRIPT` covers Han (including
  extension A and the compatibility block), kana, and the fullwidth / CJK
  punctuation that tends to sit at a line edge.

Hangul is deliberately **not** in that set: Korean spaces its words the way
Latin does, so a Korean line break wants the space and dropping it would be a
real error — the counter-example that makes "CJK" the wrong shorthand here.

## Model & boundaries

- `\r\n`, a lone `\r`, and U+2028 / U+2029 are all normalised to `\n` first —
  as far as a paste is concerned they are the same hard break.
- Trailing horizontal whitespace (including U+00A0 and U+3000) comes off every
  line before anything else. It is residue of the wrap being undone, and left
  in place it would silently decide the `'smart'` test.
- Within a paragraph, the **first** line keeps its leading whitespace (an
  authored indent) and continuation lines lose theirs (wrap residue).
- In `'para'` mode a run of blank lines collapses to a single blank line;
  in `'one'` mode blank lines disappear along with every other break.
- Line-level only: there is no hyphenation repair, so a word split as
  `archi-` / `tectures` across a break stays split — the module will not
  guess whether that hyphen was authored or inserted by the typesetter.
