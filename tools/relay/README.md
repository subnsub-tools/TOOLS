# Relay — upload client

Batch-upload orchestration, the text-paste lane, and the video → keyframes
pipeline behind the Relay tool on [subnsub.com](https://subnsub.com)
(drop a file for a short-lived link, or paste text for one that can sit
there far longer; also the standalone `/relay` page — the directory name
`link` is the tool's unchanged internal id). Published so the client-side
claims are
auditable: what the page checks before it spends an upload, how the
concurrent batch queue works, how link lifetimes are modelled — and that
the video splitter runs entirely in the browser: the source video never
leaves the device, only the packed ZIP of frames is uploaded.

## Files

- [`relay-upload.js`](relay-upload.js) — the module: `uploadBatch()`,
  `preflight()`, the lifetime model (`EXPIRY_PRESETS`,
  `PASTE_EXPIRY_PRESETS`, `FILE_MAX_MINUTES`, `expiryPresets()`,
  `sanitizeExpiryMinutes()`, `extendChoices()`), the text-paste lane
  (`pasteBytesOf()`, `pasteDisplayName()`, `pastePreflight()`,
  `canDeletePaste()`), `md5Hex()`/`md5OfBlob()`, and the video half
  (`videoToFramesZip()`, `extractKeyframeTimes()`, `captureVideoFrame()`,
  `drawChangeBoxes()`, `buildContactSheet()`, `buildZip()`)
- [`demo.html`](demo.html) — minimal standalone page. **Its uploader is an
  injected fake** (a timer that ticks progress and mints an
  `example.invalid` URL) so the queue/concurrency/progress logic can be
  demonstrated without any server; nothing leaves the page.

## Usage

The module performs no network I/O. The transport is a caller-supplied
function — resolve means stored, reject means failed:

```js
import { uploadBatch, sanitizeExpiryMinutes } from './relay-upload.js';

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
import { videoToFramesZip } from './relay-upload.js';

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
- `file` — the file, **or** `text` — a plain-text snippet (exactly one of
  the two; sending both is rejected)
- `expiresInMinutes` (optional) — requested lifetime; omitted → the
  server applies its default
- `lang` (optional, paste only) — syntax label for the viewer page

Success (2xx) JSON, fields the page consumes:
`{ id, url, name, size, type, expiresAt }` (`expiresAt` = ms epoch).

`url` is the link to hand out, and its route depends on what the stored
bytes turn out to be. A file whose first bytes decode as PNG, JPEG, GIF or
WebP — sniffed server-side from the bytes, never from the upload's declared
type or extension, so markup dressed as an image can never qualify — gets
an `/i/<id>` URL that a deployment serves inline with its true image type,
plus a `downloadUrl` (`/f/<id>`, the same object served as an attachment)
for the human-facing "save this file" affordance. Everything else gets the
`/f/<id>` URL alone and no `downloadUrl`. A client that shows one link
should show `url`; the point of the split is that pasting the primary link
into a browser or an image-reading agent yields pixels, not a download.

A text paste additionally carries `kind: 'paste'`, `raw`, the `lang` it was
created with, and `deleteToken`; its `url` is a `/p/<id>` viewer page — a
read-only, entity-escaped rendering behind a nonce CSP — whose raw
text/plain twin lives at `/p/<id>.txt` (that's the URL the agent-prompt row
variant points at). Pastes use one flat byte cap for every account
(`PASTE_MAX_BYTES` is the courtesy mirror); bigger text belongs in the file
lane as a `.txt` upload.

`deleteToken` is handed over exactly once, in that response. For an
anonymous paste it is the only proof of authorship there will ever be, so
a client that persists the record must persist the token with it —
dropping it forfeits early deletion permanently.

Failure JSON: `{ error }` — a deployment-defined code (`too_large`,
`bad_expiry`, `bad_request`, …). The module surfaces the code verbatim
through `onError` and attaches no meaning to it; which codes exist and
what limits trigger them are server policy, not module contract.

`POST /api/extend` — JSON `{ id, expiresInMinutes }` →
`{ ok: true, expiresAt }` or `{ error }`. Any share — file or paste — can
be extended once, and an expired one not at all. How far it may be
extended depends on which lane it is in, so a paste can be pushed well
past a file's ceiling; the server re-validates against the lane either
way. `extendChoices()` is the client half of that menu: pass the lane's
list (`expiryPresets('paste')` for a paste) and it drops everything at or
under the remaining time, since offering those would extend nothing.

`DELETE /api/paste?id=<id>` — takes a paste down before its expiry.
Authorization is either the capability header `x-paste-token:
<deleteToken>` or the session of the recorded author, so an anonymous
author keeps the ability to undo a mistaken paste; only the token's
SHA-256 is stored server-side. A `404` means the paste is already gone
(expired, or deleted from another device) and the page treats it the same
as a success. `canDeletePaste()` is the client-side half — whether to offer
the control at all — and decides nothing about whether the request is
honoured.

## Caps, lifetimes, and configuration

The module takes a single `maxBytes`/`maxBatch` pair and a preset list. On
subnsub.com those are configured per account and enforced server-side —
deliberately not module logic — which is why `expiresInMinutes: null`
omits the field and lets the server apply its default.

Lifetimes are per lane. A file share is a transfer: its presets stop at
`FILE_MAX_MINUTES`. A paste is a pastebin entry that people come back to,
so `PASTE_EXPIRY_PRESETS` keeps those presets and adds a day, a week, a
month and a year. `uploadBatch()` does not police that split — it forwards
whatever `expiresInMinutes` it is handed, so a caller with its own preset
list keeps working. The lane rule therefore lives one level up, in the
page: sanitize a stored lifetime against the lane it is about to be used
on (`expiryPresets('paste')` vs the default file list) and let it fall
through to `null` when it does not belong there. A page that shares one
lifetime control between both lanes — a file landing while the text
composer is open — otherwise ships a paste-only value to the file lane
and collects a rejection it could have avoided locally. Which of those
presets a given session may actually pick, and what it gets when it picks
nothing, are server-side policy.

One piece of page wiring worth noting: on site, a video over the size cap
is auto-routed into `videoToFramesZip()` instead of erroring — that
routing lives above this module.

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
