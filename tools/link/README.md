# File Sharing — upload client

Batch-upload orchestration and the video → keyframes pipeline behind the
File Sharing tool on [subnsub.com](https://subnsub.com) (drop a file, get a
short-lived link; also the standalone `/link` page). Published so the
client-side claims are auditable: what the page checks before it spends an
upload, how the concurrent batch queue works, how link lifetimes are
modelled — and that the video splitter runs entirely in the browser: the
source video never leaves the device, only the packed ZIP of frames is
uploaded.

## Files

- [`link-upload.js`](link-upload.js) — the module: `uploadBatch()`,
  `preflight()`, the lifetime model (`EXPIRY_PRESETS`,
  `sanitizeExpiryMinutes()`, `extendChoices()`), `md5Hex()`/`md5OfBlob()`,
  and the video half (`videoToFramesZip()`, `extractKeyframeTimes()`,
  `captureVideoFrame()`, `buildContactSheet()`, `buildZip()`)
- [`demo.html`](demo.html) — minimal standalone page. **Its uploader is an
  injected fake** (a timer that ticks progress and mints an
  `example.invalid` URL) so the queue/concurrency/progress logic can be
  demonstrated without any server; nothing leaves the page.

## Usage

The module performs no network I/O. The transport is a caller-supplied
function — resolve means stored, reject means failed:

```js
import { uploadBatch, sanitizeExpiryMinutes } from './link-upload.js';

const { items, ignored } = await uploadBatch(fileList, {
  upload: myTransport,          // (file, {expiresInMinutes, onProgress}) => Promise<record>
  concurrency: 3,               // worker pool size (default CONCURRENCY = 3)
  maxBytes: 10 * 1024 * 1024,   // courtesy cap — the server re-checks with the real one
  maxBatch: 20,                 // extra files are trimmed, counted in `ignored`
  expiresInMinutes: sanitizeExpiryMinutes(userInput),  // null → omitted, server default
  onStart:    (item)        => {},
  onProgress: (item, pct)   => {},
  onDone:     (item, rec)   => {},   // rec = whatever the transport resolved
  onError:    (item, err)   => {},   // err.code may carry the server error code
  onHash:     (item, md5)   => {},   // MD5 races the upload; lands when ready
});
// items keep input order: { index, file, name, size, ok, result?, error?, md5? }
```

Per file, `uploadBatch` runs the courtesy preflight first: the byte cap,
then a 1-byte read probe — a dropped folder or macOS `.app` bundle arrives
as a `File` with a plausible size but unreadable bytes, and without the
probe the failed read would surface much later as a misleading network
error (`err.code` is `'too_large'` / `'unreadable'`). Failures stay
per-file — one bad file never aborts the batch — and nothing is retried
automatically.

The transport the site itself injects, shown here as the reference for the
contract (not part of the module):

```js
function siteTransport(file, { expiresInMinutes, onProgress }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    if (expiresInMinutes != null) form.append('expiresInMinutes', String(expiresInMinutes));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(100, Math.round(e.loaded * 100 / e.total)));
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onload = () => {
      let res; try { res = JSON.parse(xhr.responseText); } catch (_) { res = {}; }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(res);
      const err = new Error('upload failed');
      err.code = (res && res.error) || ('http_' + xhr.status);
      reject(err);
    };
    xhr.send(form);
  });
}
```

Video → keyframes ZIP (browser only — it is `<video>` + `<canvas>` work):

```js
import { videoToFramesZip } from './link-upload.js';

const out = await videoToFramesZip(videoFile, {
  maxBytes: 10 * 1024 * 1024,          // the packed ZIP is thinned to fit this
  onProgress: (stage, pct, info) => {},// 'analyze' | 'extract' | 'sheet' | 'pack'
  cancelled: () => false,              // poll-to-abort; true → resolves null
});
// out = { file, sheet, frameCount, duration }
// file  = File "<source>-frames.zip": contact-sheet.jpg + frame-N.jpg
// err.code on reject: 'format' | 'decode' | 'extract' | 'zip_size'
```

## Upload endpoint contract (the client-visible face)

What the page sends and consumes; **the server is the enforcement point**
for every limit below — the module's caps are courtesy preflights only, and
a forged oversize/over-quota request is rejected server-side regardless.

`POST /api/upload` — `multipart/form-data`
- `file` — the file
- `expiresInMinutes` (optional) — requested lifetime; omitted → the
  server applies its default

Success (2xx) JSON, fields the page consumes:
`{ id, url, name, size, type, expiresAt }` (`expiresAt` = ms epoch).

Failure JSON: `{ error }` — a deployment-defined code (`too_large`,
`bad_expiry`, `bad_request`, …). The module surfaces the code verbatim
through `onError` and attaches no meaning to it; which codes exist and
what limits trigger them are server policy, not module contract.

`POST /api/extend` — JSON `{ id, expiresInMinutes }` →
`{ ok: true, expiresAt }` or `{ error }`. Each file can be extended once;
`extendChoices()` mirrors the client rule that only presets longer than the
remaining time are offered.

## Caps, lifetimes, and configuration

The module takes a single `maxBytes`/`maxBatch` pair and a preset list. On
subnsub.com those are configured per account and enforced server-side —
deliberately not module logic — which is why `expiresInMinutes: null`
omits the field and lets the server apply its default. One piece of page
wiring worth noting: on site, a video over the size cap is auto-routed
into `videoToFramesZip()` instead of erroring — that routing lives above
this module.

## How keyframes are picked

- **Change metric**: frames are compared as 96-px grayscale thumbs split
  into an 8×8 block grid, scored by the *worst block's* mean abs diff — a
  small glitching region reads like a scene cut instead of vanishing into a
  full-frame average.
- **Play scan** (clips ≤ 30 s, when `requestVideoFrameCallback` exists):
  the clip is played once, muted, scoring *every presented frame* — no
  sampling gap for an A→B→A transient to hide in. Playback slows itself
  when the decoder reports dropped frames.
- **Seek scan** (everything else): a coarse ~1/s grid, then a bisection
  budget spent on whichever interval shows the biggest change, down to
  1/8 s; leftover budget blind-probes the widest remaining gap.
- Frame count scales with footage and distinct change moments (6–32); the
  store-only ZIP's size is computed exactly from blob sizes before any
  bytes materialize, thinning to every other frame until it fits
  `maxBytes`.

The upload half of the module is environment-free (runs under Node for
testing); the video half requires a browser. The MD5 is the standard
RFC 1321 digest, offered because users expect the familiar 32-char string
for a quick integrity check — it is not a security feature.
