# JSON Formatter

Pretty-print, minify, or just validate JSON — the core logic of the JSON
tab on [subnsub.com](https://subnsub.com), published so the parsing and
the error reporting the site runs on your data are auditable.

## Files

- [`json-format.js`](json-format.js) — the module: `format()`, `minify()`, `validate()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { format, minify, validate } from './json-format.js';

format('{"a":[1,2],"b":true}');
// '{\n  "a": [\n    1,\n    2\n  ],\n  "b": true\n}'
format('{"b":2}', 4);            // 4-space indent (the tab offers 2 or 4)

minify('{ "a" : [ 1, 2 ] }');    // '{"a":[1,2]}'

validate('{"a":1}');             // { valid: true }
validate('{\n  "a" 1\n}');
// { valid: false, message: "Expected ':' after property name ", line: 2, col: 7 }
```

`format()` and `minify()` throw the parse `SyntaxError` untouched; call
`validate()` when you want the located form.

## Notes

- `JSON.parse` is the validator — no hand-rolled grammar to drift out of
  sync with the platform. The module's own contribution is error
  geometry: the byte offset engines embed in their messages
  ("… at position N") is converted to a 1-based line/column.
- That makes line/col best-effort by nature: message wording is
  engine-specific, and some errors (V8's short-input `Unexpected token`
  form, for example) carry no position at all. When the engine doesn't
  say, `line`/`col` are `null` and `message` is passed through verbatim.
- Input is trimmed before parsing; reported positions are relative to
  the trimmed text, exactly as in the tab.
