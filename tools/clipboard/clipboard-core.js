/* Clipboard interop layer — core logic of the Clipboard tab on subnsub.com,
   kept in lockstep with the in-page version.

   The tab has two faces: saved text snippets you can re-copy with one
   click, and image slots that land on this machine's clipboard as a real
   PNG bitmap. This module is the browser-clipboard half of both — the
   parts that have to be exactly right across engines:

   - Text writes report success as a boolean; reads distinguish
     "permission denied / API missing" from "clipboard is empty", because
     the caller's recovery differs (focus an input and let the user paste
     manually vs. tell them there is nothing to grab).
   - Image writes hand ClipboardItem a PROMISE payload: Safari only
     honours clipboard.write() inside the user-gesture window, and
     awaiting a download or decode first would close it. Engines that
     reject a promise payload get a second write with the resolved blob —
     the SAME pipeline result, never a second download or decode.
   - Everything written as an image is normalised to PNG (the one format
     every engine accepts from ClipboardItem). PNG input passes through
     byte-identical; anything else is decoded and re-encoded via canvas
     behind a decode-bomb budget (16384 px per axis, 64 MP area) — a byte
     cap alone does not bound DECODED size.
   - Paste extraction is split image-first: a pasted screenshot must be
     claimed (capture phase) before any text handler can misread it as an
     empty text paste, while pastes aimed at editable fields are left
     alone entirely.

   No storage and no network here. On subnsub.com the snippet history
   rides the account's settings sync and the cross-device image slots are
   kept by the site's server under the signed-in account — this module
   only ever sees text and blobs the host already holds.

   Browser-only by nature: the async clipboard API needs a secure context
   (HTTPS or localhost), and the PNG re-encode uses Image + canvas. */

/* canvas budget, enforced by both the measure step and the PNG re-encode:
   axes 16384, area 64 MP — matches the ceiling common engines allocate. */
export const CANVAS_MAX_AXIS = 16384;
export const CANVAS_MAX_AREA = 64 * 1024 * 1024;

function fail(code) {
  const e = new Error(code === 'denied' ? 'No permission to read the clipboard.'
    : code === 'empty' ? 'The system clipboard is empty.'
    : code === 'unsupported' ? 'The browser exposes no programmatic image-clipboard API.'
    : code === 'notimage' ? 'That file is not an image.'
    : code === 'huge' ? 'Image dimensions exceed the canvas budget.'
    : code === 'decode' ? 'Could not decode that image.'
    : code === 'encode' ? 'Could not encode that image as PNG.'
    : 'Could not process this input.');
  e.code = code;
  return e;
}

/* ── text ── */

/* Write plain text. Resolves true on success, false when the engine
   refused (API missing, no permission, gesture window expired) — callers
   flash a "copied" cue on true and stay quiet otherwise. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text)); return true; } catch { return false; }
}

/* Read the system clipboard as text. readText() is blocked without
   permission (and unsupported outright in e.g. Firefox) — that surfaces
   as err.code 'denied' so the caller can fall back to "paste it manually";
   a readable-but-blank clipboard is 'empty'. */
export async function readText() {
  let text = '';
  try { text = await navigator.clipboard.readText(); }
  catch (_) { throw fail('denied'); }
  if (!text || !text.trim()) throw fail('empty');
  return text;
}

/* Full clipboard read, image-first — the "From clipboard" button's face.
   readText() alone misreports an image-only clipboard (a screenshot) as
   empty, so hosts with an image sink call this instead. Resolves
   { kind:'image', blob } for the first image flavour found, else
   { kind:'text', text } — image wins when both are present, the same
   precedence imageFromPaste() gives a paste. Hosts without an image sink
   (signed-out, image UI absent) pass wantImage:false to skip straight to
   text extraction from the SAME read — no second permission interaction.
   Throws 'denied' when read() is refused (no readText() retry: one
   permission prompt per user gesture) and 'empty' when nothing usable is
   found. Engines without read() fall back to the text-only readText(). */
export async function readClipboard(wantImage = true) {
  if (!(navigator.clipboard && navigator.clipboard.read)) {
    return { kind: 'text', text: await readText() };
  }
  let items = null;
  try { items = await navigator.clipboard.read(); }
  catch (_) { throw fail('denied'); }
  if (wantImage) {
    for (const it of (items || [])) {
      const t = (it.types || []).find(x => /^image\//.test(x));
      if (!t) continue;
      let blob = null;
      try { blob = await it.getType(t); } catch (_) {}
      if (blob && blob.size) return { kind: 'image', blob };
    }
  }
  let text = '';
  for (const it of (items || [])) {
    if (!(it.types || []).includes('text/plain')) continue;
    /* Response#text() instead of Blob#text(): Safari 13.1 ships read()
       without Blob#text(). getType() may also reject or yield blank
       (clipboard changed after read(); multi-item clipboards) — keep
       scanning instead of committing to the first candidate. */
    try {
      const t = await new Response(await it.getType('text/plain')).text();
      if (t && t.trim()) { text = t; break; }
    } catch (_) {}
  }
  if (!text || !text.trim()) throw fail('empty');
  return { kind: 'text', text };
}

/* ── paste extraction ── */

/* True when an event target is an editable field. Page-level paste
   capture must skip those, so inputs and textareas keep their normal
   paste-to-edit behaviour. */
export function isEditableTarget(tgt) {
  return !!(tgt && (tgt.isContentEditable || (tgt.closest && tgt.closest('input,textarea,select'))));
}

/* Plain-text face of a paste. The paste gesture hands clipboardData over
   synchronously, so this lands even where readText() is blocked. */
export function textFromPaste(clipboardData) {
  return clipboardData ? clipboardData.getData('text/plain') : '';
}

/* Image face of a paste — the first image file among the items, or null.
   Hosts that want screenshot pastes to win must run this from a
   CAPTURE-phase listener and stopImmediatePropagation() on a hit, so no
   text handler downstream double-handles the paste or misreads it as an
   empty text paste. Text-only pastes fall through untouched (null). */
export function imageFromPaste(clipboardData) {
  const its = clipboardData && clipboardData.items;
  if (!its) return null;
  for (let i = 0; i < its.length; i++) {
    if (its[i].kind === 'file' && /^image\//.test(its[i].type)) {
      const f = its[i].getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/* ── image pipeline ── */

export function withinCanvasBudget(w, h) {
  return !(w > CANVAS_MAX_AXIS || h > CANVAS_MAX_AXIS || w * h > CANVAS_MAX_AREA);
}

/* Local decode as the image gate: rejects non-images with err.code
   'notimage' and yields the intrinsic w/h (display metadata, and the
   input to the canvas-budget check). The object URL is revoked on both
   paths. */
export function imageDims(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => { const d = { w: im.naturalWidth, h: im.naturalHeight }; URL.revokeObjectURL(url); d.w && d.h ? res(d) : rej(fail('notimage')); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(fail('notimage')); };
    im.src = url;
  });
}

/* Normalise a blob to PNG for ClipboardItem. PNG bytes pass through
   untouched; anything else is decoded and re-encoded through a canvas,
   behind the decode-bomb budget. Rejects with err.code 'huge' (over
   budget), 'decode' or 'encode'. */
export function toPng(blob) {
  if (blob.type === 'image/png') return Promise.resolve(blob);
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => {
      const w = im.naturalWidth, h = im.naturalHeight;
      if (!withinCanvasBudget(w, h)) {
        URL.revokeObjectURL(url);
        rej(fail('huge'));
        return;
      }
      try {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0);
        c.toBlob(b => b ? res(b) : rej(fail('encode')), 'image/png');
      } catch (e) { rej(e); }
      finally { URL.revokeObjectURL(url); }
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(fail('decode')); };
    im.src = url;
  });
}

/* Put an image on the clipboard as a real PNG bitmap.

   `source` is a Blob, a Promise of one, or a function returning either —
   on subnsub.com it is the streaming download of the slot's original
   bytes; a local file works just as well. Whatever arrives is normalised
   via toPng().

   Call this synchronously from the user gesture. The ClipboardItem
   payload is the PROMISE itself: Safari's gesture window closes if the
   caller awaits the bytes first, so write() must be issued immediately
   and the payload allowed to resolve later. Engines that reject a
   promise payload get a second write with the resolved blob — the same
   pipeline (the promise is created once), never a second download.

   Throws err.code 'unsupported' when the async clipboard / ClipboardItem
   API is missing; otherwise a pipeline error ('notimage' | 'huge' |
   'decode' | 'encode') or the engine's final write rejection. */
export async function copyImage(source) {
  if (!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem)) throw fail('unsupported');
  const payload = Promise.resolve(typeof source === 'function' ? source() : source).then(toPng);
  payload.catch(() => {});   // pre-handle; the fallback path awaits it explicitly
  try {
    /* promise payload keeps Safari's gesture window open while it streams */
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': payload })]);
  } catch (_e1) {
    /* engines that reject a promise payload: hand them the resolved blob
       (same pipeline result — not a second stream) */
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await payload })]);
  }
}
