# Clipboard

The browser-clipboard interop layer behind the
[Clipboard tab on subnsub.com](https://subnsub.com) — saved text snippets
you can re-copy with one click, and image slots that land on this
machine's clipboard as a real PNG bitmap. Published so the code that
touches your clipboard (a permission-gated, user-trust surface) is
auditable: what is read, when, and what exactly gets written back.

## Files

- [`clipboard-core.js`](clipboard-core.js) — the module: `copyText()`,
  `readText()`, `readClipboard()`, `textFromPaste()`, `imageFromPaste()`,
  `isEditableTarget()`, `imageDims()`, `toPng()`, `copyImage()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import {
  copyText, readText,
  textFromPaste, imageFromPaste, isEditableTarget,
  imageDims, toPng, copyImage,
} from './clipboard-core.js';

// Text
const ok = await copyText('hello');          // → boolean, no throw
try {
  const text = await readText();
} catch (e) {
  // e.code === 'denied' → no permission / API missing (e.g. Firefox):
  //                       fall back to "paste it manually"
  // e.code === 'empty'  → clipboard readable but blank
}

// Grab button, image-first: a screenshot on the clipboard must not be
// misread as "empty". Same 'denied' / 'empty' taxonomy as readText().
try {
  const got = await readClipboard(canTakeImages());
  if (got.kind === 'image') handleImage(got.blob);
  else handleText(got.text);
} catch (e) { /* 'denied' | 'empty' */ }

// Paste, image-first: capture phase claims screenshots before any
// text handler can misread them; editable fields keep normal paste.
document.addEventListener('paste', (e) => {
  if (isEditableTarget(e.target)) return;
  const file = imageFromPaste(e.clipboardData);
  if (file) { e.preventDefault(); e.stopImmediatePropagation(); handleImage(file); }
}, true);
document.addEventListener('paste', (e) => {
  if (isEditableTarget(e.target)) return;
  const text = textFromPaste(e.clipboardData);   // sync — works where readText() is blocked
  if (text.trim()) handleText(text);
});

// Image → clipboard, synchronously inside the click handler:
const { w, h } = await imageDims(blob);      // rejects 'notimage'
await copyImage(() => fetchOriginalBytes()); // Blob | Promise | () => either
// e.code === 'unsupported' → no ClipboardItem API
// e.code === 'huge' | 'decode' | 'encode' → PNG pipeline failure
```

Requires a secure context (HTTPS or localhost) — the async clipboard API
does not exist elsewhere.

## Why the odd shapes

- **`copyImage()` takes a promise payload.** Safari only honours
  `clipboard.write()` inside the user-gesture window; awaiting a download
  or decode first closes it. So the `ClipboardItem` is created immediately
  with the *promise* of the PNG, and the bytes stream in afterwards.
  Engines that reject promise payloads get one retry with the resolved
  blob — the same pipeline result, never a second download.
- **Everything becomes PNG.** It is the one format every engine accepts
  from `ClipboardItem`; PNG input passes through byte-identical, anything
  else is re-encoded via canvas.
- **Decode is budgeted.** A byte cap alone does not bound *decoded* size,
  so `imageDims()` reports the pixel dimensions and `withinCanvasBudget()`
  tests them against a hard budget (16384 px per axis, 64 MP area); the
  on-site flow gates on that before `toPng()` re-encodes through a canvas.
  PNG input skips re-encoding entirely (byte-identical pass-through).

## Site integration (server-side, not in this repo)

On subnsub.com the Clipboard tab is a signed-in feature: the cross-device
image slots are kept by the site's server under the signed-in account —
the server is the list, slot counts and byte caps are enforced there, and
this module only receives the bytes the page has already fetched. The
text-snippet history rides the account's settings sync. Neither storage
layer is part of this module.
