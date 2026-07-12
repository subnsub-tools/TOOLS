# Diff

Line-by-line text comparison, computed locally. This is the core logic of the
[Diff tab on subnsub.com](https://subnsub.com), published so the exact
algorithm behind the highlighted view is documented and reusable.

## Files

- [`text-diff.js`](text-diff.js) — the module: `diffLines()`, `lcs()`, `MAX_LINES`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { diffLines, lcs } from './text-diff.js';

const r = diffLines('a\nb\nc', 'a\nx\nc');
// r.ops       → [{t:'=',v:'a'}, {t:'-',v:'b'}, {t:'+',v:'x'}, {t:'=',v:'c'}]
// r.added     → 1    r.removed → 1    r.unchanged → 2
// null when either side exceeds MAX_LINES (800) lines

// lcs() works on any arrays of ===-comparable values (words, tokens, …)
const ops = lcs(['a', 'b'], ['a', 'c']);
```

## Model & boundaries

- Classic longest-common-subsequence dynamic program, O(m·n) time and memory —
  that quadratic cost is why each side is capped at **800 lines**; over the
  cap the functions return `null` instead of freezing the caller.
- The result is a full edit script in document order: `'='` unchanged, `'+'`
  added (line from the second text), `'-'` removed (line from the first).
  Replaced blocks come out as removals followed by additions.
- Line-level only: lines are compared whole (`===`), there is no intra-line
  or character diff, and no whitespace normalisation.
- Text is split on `'\n'` exactly, so a trailing newline contributes one
  empty final line — same as the on-site view.
