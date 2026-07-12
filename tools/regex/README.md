# Regex Tester

Live regular-expression evaluation — the core logic of the Regex tab on
[subnsub.com](https://subnsub.com), published so what runs against your
test text is auditable: the platform's own `RegExp`, nothing rewritten.

## Files

- [`regex-test.js`](regex-test.js) — the module: `run()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { run } from './regex-test.js';

const matches = run('(\\w+)@(\\w+)\\.com', 'a@x.com b@y.com');
matches.length;      // 2
matches[0][0];       // 'a@x.com'   — the match
matches[0].index;    // 0           — its offset
matches[0].slice(1); // ['a', 'x']  — capture groups
run('(?<user>\\w+)@', 'bob@example.com')[0].groups;  // { user: 'bob' }

run('fox', 'The quick brown fox', 'i');  // flags string; tab exposes g/i/m/s
run('(', 'abc');                         // throws SyntaxError — unbalanced (
```

## Notes

- The engine is the platform's `RegExp`, so patterns behave exactly as
  they will in production JavaScript — which is the point of testing
  here. Matches are returned as the platform's own match arrays,
  untouched (`m[0]`, `m.index`, `m[1…]` with `undefined` for
  non-participating groups, named groups on `m.groups`).
- The pattern is compiled twice on purpose: first with your exact flags,
  so an invalid pattern/flag set throws the same `SyntaxError` you would
  ship; then with `g` forced in, because `matchAll` refuses non-global
  patterns and the tool always collects every match.
- Empty pattern or empty text returns `[]` — nothing to run. Callers on
  untrusted patterns should remember JS regexes can backtrack
  catastrophically; the tab runs on the user's own thread with the
  user's own pattern, so it does not sandbox that.
