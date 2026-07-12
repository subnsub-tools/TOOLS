# YAML ↔ JSON

Convert between YAML and JSON both ways with a small hand-rolled parser and
emitter — no dependency, a few hundred lines you can actually read. This is
the core logic of the [YAML ↔ JSON tab on subnsub.com](https://subnsub.com),
published so exactly what the converter does (and does not) support is
auditable rather than guessed at.

## Files

- [`yaml-convert.js`](yaml-convert.js) — the module: `parseYaml()`,
  `stringifyYaml()`, `yamlToJson()`, `jsonToYaml()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { parseYaml, stringifyYaml, yamlToJson, jsonToYaml } from './yaml-convert.js';

parseYaml('server:\n  port: 8080\n  tls: true');
// → { server: { port: 8080, tls: true } }

stringifyYaml({ list: [1, 'two', { three: null }] });
// → 'list:\n  - 1\n  - two\n  - three: null'

yamlToJson(yamlText, 2);   // YAML → pretty-printed JSON string
jsonToYaml(jsonText, 2);   // JSON → YAML string (throws on bad JSON)
```

`indent` is spaces per nesting level on the output side — the site offers
2 or 4.

## Supported subset

The parser targets the shape of real-world config files, not the YAML spec:

- Block mappings and sequences, nested by indentation; `- ` items may open
  inline (`- name: x`).
- Literal `|` and folded `>` block scalars.
- Quoted scalars (`"…"` with `\n \t \" \\`, `'…'` with `''`).
- Plain-scalar typing: `true`/`false`/`null`/`~` (all three
  capitalisations), integers, decimals, `0x…` hex, `0o…` octal. Integers
  beyond the IEEE-754 safe range stay strings so no digits are silently
  lost.
- Inline `[flow]` / `{flow}` values, tried as strict JSON first; bracketed
  lists fall back to a comma split with per-item typing.
- `#` comment lines; blank lines are ignored.

**Not supported:** anchors/aliases, tags, multi-document streams, complex
keys, same-line trailing comments. Duplicate keys resolve last-one-wins.
Parsing is deliberately non-throwing — unrecognised lines are skipped, so
pasting something half-YAML still shows a best-effort result, which is the
tool's job. The emitter quotes any string that would re-parse as another
type and writes multi-line strings as `|` literal blocks, so its own output
round-trips.
