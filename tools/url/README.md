# URL Encoder / Decoder

URL percent-encoding, both directions — the core logic of the URL tab on
[subnsub.com](https://subnsub.com), published so it is plain what the
tool does with your input: the platform's own functions, split into the
two modes that actually differ.

## Files

- [`url-codec.js`](url-codec.js) — the module: `encode()`, `decode()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { encode, decode } from './url-codec.js';

encode('https://example.com/path?q=hello world&lang=中文');
// 'https%3A%2F%2Fexample.com%2Fpath%3Fq%3Dhello%20world%26lang%3D%E4%B8%AD%E6%96%87'

encode('https://example.com/path?q=hello world&lang=中文', 'full');
// 'https://example.com/path?q=hello%20world&lang=%E4%B8%AD%E6%96%87'

decode('q%3Dhello%20world');              // 'q=hello world'
decode('https://e.com/a%20b?x=%2F', 'full');
// 'https://e.com/a b?x=%2F' — escapes of reserved characters stay encoded
```

The second argument matches the tab's toggle: `'component'` (default)
or `'full'`.

## Notes

This module is knowingly a thin wrapper — `encodeURIComponent` /
`encodeURI` and their decoders *are* the algorithm. What the tool
contributes is the mode split and its boundary behavior:

- **Component** encodes every reserved character; it is the right mode
  for query values, path segments and form fields.
- **Full URL** treats the input as a complete URL: `:/?#[]@` and the
  sub-delims pass through on encode, and on decode their `%XX` escapes
  are deliberately left encoded (the platform guarantees the round trip
  cannot change what the URL means).
- Errors surface as the platform's `URIError`: lone surrogates on
  encode, malformed `%XX` sequences on decode.
