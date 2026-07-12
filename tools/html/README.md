# HTML Entities

Encode special characters to HTML entities and decode any entity back —
the core logic of the HTML tab on [subnsub.com](https://subnsub.com),
published so the transformation the site runs on your markup is
auditable.

## Files

- [`html-entities.js`](html-entities.js) — the module: `encode()`, `decode()`, `ENTITIES`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { encode, decode, ENTITIES } from './html-entities.js';

encode('<p>Tom & Jerry’s</p>');
// '&lt;p&gt;Tom &amp; Jerry’s&lt;/p&gt;'          (safe mode — markup chars only)

encode('<p>Tom & Jerry’s — café</p>', true);
// '&lt;p&gt;Tom &amp; Jerry&#x2019;s &#x2014; caf&#xe9;&lt;/p&gt;'   (all non-ASCII too)

decode('&lt;b&gt;5 &euro; &#8594; caf&#xe9;&lt;/b&gt;');
// '<b>5 € → café</b>' — named, decimal and hex references alike

ENTITIES;  // the tab's reference grid: [['&','&amp;'], ['<','&lt;'], …]
```

## Notes

- **Safe mode** (default) encodes only the five characters that can
  change markup meaning: `& < > " '` — the apostrophe as `&#x27;`,
  since `&apos;` is XML-born and pre-HTML5 parsers never knew it.
  **All mode** additionally turns every code point above U+007F into a
  hex numeric reference, for markup that must survive non-UTF-8
  channels.
- Decoding delegates to the platform's HTML parser through a detached
  `<textarea>`: it resolves every named, decimal and hex reference the
  browser knows — a completeness no bundled table would match — and,
  because a textarea parses as RCDATA, the input can only ever become
  text; no element is instantiated and no script can run. The element
  is never attached to a page.
- That makes `decode()` the one function in this repository that needs
  a `document` — a browser, or a DOM shim under Node. `encode()` and
  `ENTITIES` work anywhere.
