/* File-share upload client — batch orchestration, the link-lifetime model,
   and the video → keyframes ZIP pipeline. Core logic of the Link tool on
   subnsub.com (drop a file, get a short-lived link), kept in lockstep with
   the in-page version.

   Upload half (environment-free):
     uploadBatch() trims the batch to maxBatch, then runs a small worker
     pool — min(concurrency, n) workers pulling file indexes off one shared
     counter, so at most `concurrency` uploads are in flight and a finished
     slot immediately picks up the next file. Per file it runs the courtesy
     preflight (byte cap, then a 1-byte read probe that catches dropped
     folders and macOS .app bundles), hands the file to the INJECTED
     transport (options.upload) and relays its progress; an MD5 of the
     exact bytes being uploaded is computed in parallel and folded in once
     it lands. Failures stay per-file — one bad file never aborts the
     batch — and nothing is retried automatically; the caller decides what
     to re-submit.

     The module performs no network I/O and owns no endpoint: the transport
     is a caller-supplied async function (the site injects an XHR POST to
     its upload Function — see the README for the request/response shape).
     Every cap here is a courtesy check only; the SERVER is the enforcement
     point and rejects oversize or over-quota uploads no matter what a
     client claims. On subnsub.com maxBytes/maxBatch are set per account
     tier; here they are plain options.

   Lifetime model:
     Link lifetimes come from a fixed preset list (EXPIRY_PRESETS, in
     minutes). sanitizeExpiryMinutes() admits only an exact integer that is
     on the list — never a silently-invented in-between — and
     extendChoices() returns the presets that would actually lengthen a
     still-live link. expiresInMinutes: null omits the field entirely so
     the server applies its own default for the session.

   Video half (browser-only — <video> and <canvas> are the whole point):
     videoToFramesZip() turns a video file into a store-only ZIP of
     keyframes plus a contact sheet, entirely client-side: the source video
     never leaves the browser, only the packed ZIP is meant for upload, and
     there is no input-size cap because nothing but the ZIP is bounded.
     Keyframes are picked by scoring frame-to-frame change on 96-px
     grayscale thumbs split into an 8×8 block grid; short clips are PLAYED
     once (muted) scoring every presented frame, long clips fall back to an
     adaptive coarse-to-fine seek scan. See the comments on each stage. */

export const CONCURRENCY = 3;

/* Baseline caps — a conservative default. The real cap is configured and
   enforced server-side; callers here pass their own maxBytes/maxBatch. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_BATCH = 1;

/* ── formatters (pure; the in-page rows render through these) ── */
export function formatBytes(n){
  if(n < 1024) return n + ' B';
  if(n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
/* Countdown text for a remaining-lifetime tick (HH:MM:SS, floored at zero). */
export function formatDuration(ms){
  if(ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}
/* Media-style position text (m:ss, growing to h:mm:ss past an hour) —
   used for frame labels and the ZIP metadata. */
export function formatVideoTime(s){
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return (m > 59 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}
/* MIME first, extension as fallback: drag-and-drop and some pickers hand
   over container formats with an empty type. */
export function isVideoFile(file){
  if(!file) return false;
  if(file.type && file.type.startsWith('video/')) return true;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv'].includes(ext);
}

/* ── link-lifetime model ──
   The lifetime picker is a fixed chip set; a stored or requested value
   that is not on the list must fall back to a caller-chosen default —
   never a silently-invented in-between. On subnsub.com which presets are
   offered and what the no-choice default is are account policy applied
   server-side, not module logic, and the server re-validates every
   request regardless. */
export const EXPIRY_PRESETS = [5, 10, 15, 30, 60, 120, 180, 300]; /* minutes */

/* Exact integer that is on the allowed list, or null. Exact-integer
   only — a tampered '120abc' or '5.9' must not slip past as a valid
   preset the way parseInt alone would coerce it. */
export function sanitizeExpiryMinutes(raw, allowed = EXPIRY_PRESETS){
  const v = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  return allowed.includes(v) ? v : null;
}

/* Presets that would actually lengthen a link expiring at `expiresAt`
   (ms epoch): anything at or under the remaining time is pointless and
   is dropped. An already-expired link gets no choices — there is nothing
   left to extend. (On the site each file can be extended once; that flag
   lives with the server record, not here.) */
export function extendChoices(expiresAt, allowed = EXPIRY_PRESETS, now = Date.now()){
  if(!(expiresAt > now)) return [];
  const remainMin = Math.ceil((expiresAt - now) / 60000);
  return allowed.filter(min => min > remainMin);
}

/* ── courtesy preflight — the checks the page runs before spending an
   upload. Resolves { ok: true } or { ok: false, error }:
     'too_large'  — over the caller's byte cap. The server re-checks with
                    the account's real cap; this only skips pointless work.
     'unreadable' — the 1-byte probe failed. A dropped folder or macOS
                    .app bundle arrives as a File with a plausible-looking
                    size but unreadable bytes; the failed read would
                    otherwise surface much later as a misleading
                    "network error". */
export async function preflight(file, maxBytes = DEFAULT_MAX_BYTES){
  if(file.size > maxBytes) return { ok: false, error: 'too_large' };
  try { await file.slice(0, 1).arrayBuffer(); }
  catch (_){ return { ok: false, error: 'unreadable' }; }
  return { ok: true };
}

/* ── MD5 over raw bytes — WebCrypto only offers SHA-*, and users expect
   the familiar 32-char MD5 for a quick file-integrity check. Standard
   RFC 1321 algorithm. ── */
const MD5_K = (() => { const k = new Uint32Array(64); for(let i = 0; i < 64; i++) k[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) >>> 0; return k; })();
const MD5_S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22, 5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20, 4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23, 6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
export function md5Hex(bytes){
  const rl = (x, c) => (x << c) | (x >>> (32 - c));
  const len = bytes.length, bitLen = len * 8;
  const padLen = (Math.ceil((len + 9) / 64)) * 64;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[len] = 0x80;
  const lo = bitLen >>> 0, hi = Math.floor(bitLen / 0x100000000) >>> 0;
  buf[padLen-8]=lo&0xff; buf[padLen-7]=(lo>>>8)&0xff; buf[padLen-6]=(lo>>>16)&0xff; buf[padLen-5]=(lo>>>24)&0xff;
  buf[padLen-4]=hi&0xff; buf[padLen-3]=(hi>>>8)&0xff; buf[padLen-2]=(hi>>>16)&0xff; buf[padLen-1]=(hi>>>24)&0xff;
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for(let off = 0; off < padLen; off += 64){
    for(let i = 0; i < 16; i++){ const j = off + i * 4; M[i] = buf[j] | (buf[j+1] << 8) | (buf[j+2] << 16) | (buf[j+3] << 24); }
    let A = a0, B = b0, C = c0, D = d0;
    for(let i = 0; i < 64; i++){
      let F, g;
      if(i < 16){ F = (B & C) | (~B & D); g = i; }
      else if(i < 32){ F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if(i < 48){ F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B; B = (B + rl(F >>> 0, MD5_S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = n => { let s = ''; for(let i = 0; i < 4; i++){ s += (((n >>> (i * 8)) & 0xff)).toString(16).padStart(2, '0'); } return s; };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
/* Whole-buffer hash of a Blob; resolves null (never rejects) on anything
   unreadable so a failed hash can never break an upload that succeeded. */
export async function md5OfBlob(blob){
  if(!(blob instanceof Blob)) return null;
  try { return md5Hex(new Uint8Array(await blob.arrayBuffer())); }
  catch (_){ return null; }
}

/* ── batch upload orchestration ──
   files    Array (or FileList) of File/Blob.
   options:
     upload            REQUIRED transport:
                         (file, { expiresInMinutes, onProgress }) => Promise
                       Resolve = stored (the result should carry the
                       server's record — url, expiresAt, …); reject =
                       failed (err.code may carry the server error code).
                       The module itself never touches the network.
     concurrency       parallel uploads (default CONCURRENCY).
     maxBytes          courtesy byte cap (default DEFAULT_MAX_BYTES).
     maxBatch          batch cap; extra files are trimmed and counted in
                       the returned `ignored` (default DEFAULT_MAX_BATCH).
     expiresInMinutes  requested lifetime for every file in the batch, or
                       null to omit it (the server default applies).
     onStart(item), onProgress(item, pct), onDone(item, result),
     onError(item, err), onHash(item, md5)   all optional.

   Resolves { items, ignored } once every accepted upload settled. Items
   keep input order: { index, file, name, size, ok, result?, error?,
   md5? }. Failures are per-item and nothing retries automatically. The
   MD5 races the upload and is folded in when it lands (onHash) — for a
   large file that can be shortly after the batch resolves. */
export async function uploadBatch(files, options){
  const {
    upload,
    concurrency = CONCURRENCY,
    maxBytes = DEFAULT_MAX_BYTES,
    maxBatch = DEFAULT_MAX_BATCH,
    expiresInMinutes = null,
    onStart, onProgress, onDone, onError, onHash,
  } = options || {};
  if(typeof upload !== 'function') throw new TypeError('options.upload must be a function');
  let list = Array.from(files || []);
  let ignored = 0;
  if(list.length > maxBatch){
    ignored = list.length - maxBatch;
    list = list.slice(0, maxBatch);
  }
  const items = list.map((file, index) => ({ index, file, name: file.name, size: file.size, ok: false }));

  const uploadOne = async (item) => {
    if(onStart) onStart(item);
    const pre = await preflight(item.file, maxBytes);
    if(!pre.ok){
      const e = new Error(pre.error === 'too_large'
        ? 'File too large'
        : "Can't upload a folder or .app bundle — compress it to a .zip first");
      e.code = pre.error;
      item.error = e;
      if(onError) onError(item, e);
      return;
    }
    /* Hash the exact bytes we're about to upload, in parallel with the
       upload itself; folded into the item once both land. A failed
       upload discards the hash — there is nothing to attach it to. */
    const md5P = md5OfBlob(item.file);
    let result;
    try {
      result = await upload(item.file, {
        expiresInMinutes,
        onProgress: pct => { if(onProgress) onProgress(item, pct); },
      });
    } catch (err){
      item.error = err;
      if(onError) onError(item, err);
      return;
    }
    item.ok = true;
    item.result = result;
    if(onDone) onDone(item, result);
    md5P.then(md5 => {
      if(!md5) return;
      item.md5 = md5;
      if(result && typeof result === 'object') result.md5 = md5;
      if(onHash) onHash(item, md5);
    });
  };

  /* Worker pool over one shared index: at most `concurrency` uploads in
     flight, and a finished slot immediately pulls the next file. */
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while(true){
      const myIdx = i++;
      if(myIdx >= items.length) return;
      await uploadOne(items[myIdx]);
    }
  });
  await Promise.all(workers);
  return { items, ignored };
}

/* ═══════════════ video → keyframes → ZIP (browser-only) ═══════════════
   <video> + <canvas> only — the source video never leaves the browser;
   only the packed ZIP of frames is meant for upload. No input-size cap:
   the video is decoded locally, so the only hard limit is the packed
   ZIP's byte cap, enforced (with auto-thinning) at pack time. */

/* Frame width 1536: screen-recording text must stay legible in the
   extracted frames — 640 reads only for full-screen scene changes.
   ~1.5k matches the useful input width of multimodal models; wider grows
   the ZIP with no comprehension gain (thinning still guards the cap).
   Frames are never upscaled past the source. */
export const FRAME_WIDTH = 1536;
export const PLAY_SCAN_MAX = 30; /* s — beyond this, sitting through playback costs more than seek precision is worth */

function vfail(code){
  const e = new Error(code === 'format' ? 'Video format not supported by this browser.'
    : code === 'decode' ? 'Video could not be decoded.'
    : code === 'zip_size' ? 'ZIP exceeds the upload size limit.'
    : 'Could not extract any frames.');
  e.code = code;
  return e;
}

/* Await the `seeked` event for a currentTime assignment, bounded at 5 s —
   a codec/container that never fires it must not hang the pipeline. */
export function seekVideoFrame(video, time){
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { video.removeEventListener('seeked', onSeeked); reject(new Error('timeout')); }, 5000);
    function onSeeked(){ clearTimeout(timer); video.removeEventListener('seeked', onSeeked); resolve(); }
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

/* Draw the video's current frame onto a fresh canvas (≤ FRAME_WIDTH wide,
   never upscaled) and burn an "#index  m:ss" watermark into the corner so
   each frame stays self-describing outside the ZIP. */
export function captureVideoFrame(video, index, time){
  const cw = Math.min(FRAME_WIDTH, video.videoWidth);
  const ch = Math.round(cw * video.videoHeight / video.videoWidth);
  const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, cw, ch);
  const label = '#' + (index + 1) + '  ' + formatVideoTime(time);
  const fontSize = Math.max(10, Math.round(cw * 0.022));
  ctx.font = 'bold ' + fontSize + 'px "Space Mono",monospace';
  const pad = 5, boxH = fontSize + pad * 2, textW = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(0, ch - boxH, textW + pad * 2, boxH);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, pad, ch - boxH / 2);
  return canvas;
}

/* Tile frame canvases into one overview grid (≤6 columns) with a header
   line; returns the sheet canvas. */
export function buildContactSheet(frames, headerText){
  let cols = Math.ceil(Math.sqrt(frames.length)); if(cols > 6) cols = 6;
  const rows = Math.ceil(frames.length / cols);
  const cw = frames[0].width, ch = frames[0].height, gap = 2, header = 32;
  const sw = cols * cw + (cols - 1) * gap, sh = header + rows * ch + (rows - 1) * gap;
  const canvas = document.createElement('canvas'); canvas.width = sw; canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, sw, sh);
  ctx.fillStyle = '#888'; ctx.font = '12px "Space Mono",monospace'; ctx.textBaseline = 'middle';
  ctx.fillText(headerText, 8, header / 2);
  frames.forEach((frameCanvas, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    ctx.drawImage(frameCanvas, col * (cw + gap), header + row * (ch + gap));
  });
  return canvas;
}

/* ── ZIP builder (store-only, no compression needed for JPEG) ── */
export function buildZip(entries){
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for(const { name, data } of entries){
    const nameBytes = enc.encode(name);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const local = new Uint8Array(30 + nameBytes.length + bytes.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(8, 0, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint32(18, bytes.length, true);
    v.setUint32(22, bytes.length, true);
    local.set(nameBytes, 30);
    local.set(bytes, 30 + nameBytes.length);
    const crc = crc32(bytes);
    v.setUint32(14, crc, true);
    parts.push(local);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);
    offset += local.length;
  }
  const centralOffset = offset;
  let centralSize = 0;
  for(const c of central) centralSize += c.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
function crc32(buf){
  let crc = 0xFFFFFFFF;
  for(let i = 0; i < buf.length; i++){
    crc ^= buf[i];
    for(let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ── Smart keyframe picking: two scan modes, one selection pass ──

   Change metric (both modes): frames are compared as 96px grayscale
   thumbs split into an 8×8 block grid, scored by the WORST block's
   mean abs diff. A full-frame mean buries small-area changes — a
   glitching widget at ~5% of a screen recording reads ~2, below any
   usable noise floor, so the whole clip classifies as static; the
   same event's worst block reads like a scene cut (real case: a
   0.14 s layout jump scored 2.0 full-frame, 31 block-max). Full-frame
   cuts are unaffected: every block ≈ the global mean, max ≥ mean.

   PLAY SCAN (short clips): seek sampling at ANY density cannot rule
   out a transient between two samples — an A→B→A glitch lives and
   dies inside the gap and leaves identical endpoints. Clips short
   enough to sit through are instead PLAYED once, muted, scoring
   EVERY presented frame via requestVideoFrameCallback: no gap, so
   nothing can hide. High-fps recordings outrun the ~60 Hz compositor,
   so playback drops to 0.5× the moment frame cadence shows skipping.

   SEEK SCAN (long clips, rVFC missing, playback stalled): the
   adaptive coarse-to-fine pass — a coarse grid (~1/s) for whole-clip
   coverage, then a refinement budget repeatedly bisecting whichever
   interval shows the biggest diff, down to 1/8 s. Leftover budget
   blind-probes the widest remaining interval so transients hiding
   inside same-endpoint gaps still have a chance of being hit. */
function grayFrame(cx, aw, ah){
  const d = cx.getImageData(0, 0, aw, ah).data;
  const g = new Float32Array(aw * ah);
  for(let p = 0; p < g.length; p++){ const q = p * 4; g[p] = d[q] * .299 + d[q + 1] * .587 + d[q + 2] * .114; }
  return g;
}
function blockDiff(a, b, aw, ah){
  if(!a || !b) return 0;
  const GB = 8;
  const sums = new Float32Array(GB * GB), counts = new Float32Array(GB * GB);
  for(let y = 0; y < ah; y++){
    const rowB = Math.min(GB - 1, (y * GB / ah) | 0) * GB, rowOff = y * aw;
    for(let x = 0; x < aw; x++){
      sums[rowB + Math.min(GB - 1, (x * GB / aw) | 0)] += Math.abs(a[rowOff + x] - b[rowOff + x]);
      counts[rowB + Math.min(GB - 1, (x * GB / aw) | 0)]++;
    }
  }
  let max = 0;
  for(let i = 0; i < GB * GB; i++) if(counts[i]) max = Math.max(max, sums[i] / counts[i]);
  return max;
}
/* Play the clip once and score every presented frame against its
   predecessor. Returns {segs, firstPt, frameDur} shaped for the
   shared selection pass, or null to fall back to seek sampling (no
   rVFC, clip too long to sit through, autoplay refused — e.g. iOS
   low-power mode — or a stall/background-tab timeout). Temporarily
   pins the video into the page as a transparent 2px speck: rVFC may
   never fire for an element the compositor considers invisible. */
async function playScanFrames(vid, onStep, cancelled){
  if(typeof vid.requestVideoFrameCallback !== 'function') return null;
  const duration = vid.duration;
  if(duration > PLAY_SCAN_MAX) return null;
  const aw = 96, ah = Math.max(1, Math.round(aw * vid.videoHeight / vid.videoWidth));
  const c = document.createElement('canvas'); c.width = aw; c.height = ah;
  const cx = c.getContext('2d', { willReadFrequently: true });
  vid.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
  document.body.appendChild(vid);
  const segs = [], deltas = [];
  let firstPt = null, prevG = null, lastT = -1;
  try {
    /* a fresh element already sits at 0 and assigning an equal
       currentTime may never fire `seeked`; only seek back when the
       Infinity-duration probe actually moved the head. */
    try { if(vid.currentTime > 0.001) await seekVideoFrame(vid, 0); } catch (_){ return null; }
    if(cancelled() || document.hidden) return null;
    /* ≤15 s clips start at 0.5× outright: every media frame gets a
       compositor slot even at 120 fps, for ≤30 s of wall-clock.
       Longer clips start at 1× and only slow down on evidence of
       skipping, keeping worst-case wall-clock ≈ PLAY_SCAN_MAX×2. */
    vid.playbackRate = duration <= PLAY_SCAN_MAX / 2 ? 0.5 : 1;
    try { await vid.play(); } catch (_){ return null; }
    let dropBase = typeof vid.getVideoPlaybackQuality === 'function'
      ? vid.getVideoPlaybackQuality().droppedVideoFrames : -1;
    const ok = await new Promise(resolve => {
      let done = false, rvfcId = 0, stall = 0, watermark = -1;
      const fin = good => {
        if(done) return; done = true;
        clearTimeout(stall); vid.removeEventListener('ended', onEnd);
        document.removeEventListener('visibilitychange', onVis);
        try { vid.cancelVideoFrameCallback(rvfcId); } catch (_){}
        resolve(good);
      };
      /* frame watchdog: a decode stall freezes both the callback
         stream AND the clock → abandon for seek scan. A VFR screen
         recording's static stretch also goes 10 s+ without frames,
         but its clock keeps advancing → keep waiting for `ended`. */
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          if(vid.currentTime > watermark + 0.5){ watermark = vid.currentTime; arm(); }
          else fin(false);
        }, 10000);
      };
      const onEnd = () => fin(true);
      /* a hidden tab plays on but presents no frames — every frame
         from here would be silently skipped, so bail, don't trust. */
      const onVis = () => { if(document.hidden) fin(false); };
      vid.addEventListener('ended', onEnd);
      document.addEventListener('visibilitychange', onVis);
      const tick = (_, meta) => {
        if(cancelled()) return fin(false);
        arm();
        const t = meta.mediaTime;
        if(t > lastT){
          let g = null;
          try { cx.drawImage(vid, 0, 0, aw, ah); g = grayFrame(cx, aw, ah); } catch (_){ return fin(false); }
          if(prevG){
            segs.push({ b: { t }, score: blockDiff(prevG, g, aw, ah) });
            deltas.push(t - lastT);
            /* skip detector: media-time deltas can't expose skipping
               (a saturated compositor presents every vsync, so the
               delta reads rate×vsync no matter how many frames died
               in between) — ask the decoder directly. >25% dropped
               across a 16-frame window means the cadence outruns
               presentation: halve speed until every frame earns a
               slot (240 fps needs two halvings; floor 0.25×). A
               decode-bound machine trips this too — same remedy. */
            if(dropBase >= 0 && deltas.length % 16 === 0){
              const dr = vid.getVideoPlaybackQuality().droppedVideoFrames;
              if(dr > dropBase + 4 && vid.playbackRate > 0.26) vid.playbackRate /= 2;
              dropBase = dr;
            }
          } else {
            firstPt = { t, g };
          }
          prevG = g; lastT = t;
          onStep(Math.min(100, Math.round(t / duration * 100)), 100);
        }
        rvfcId = vid.requestVideoFrameCallback(tick);
      };
      arm();
      rvfcId = vid.requestVideoFrameCallback(tick);
    });
    if(!ok || cancelled() || segs.length < 8) return null;
    /* 25th-percentile delta, not the median: VFR recordings burst to
       high fps exactly where things change, and change frames are the
       ones we'll seek back to — undershooting their true duration is
       harmless, overshooting lands the seek on the next frame. */
    deltas.sort((x, y) => x - y);
    return { segs, firstPt, frameDur: deltas[deltas.length >> 2] || 1 / 30 };
  } finally {
    try { vid.pause(); } catch (_){}
    vid.playbackRate = 1;
    vid.remove();
    vid.style.cssText = '';
  }
}
/* Pick the timestamps worth keeping from a metadata-ready <video>.
   Resolves an ascending array of seconds, or null when cancelled().
     onStep(i, total) — scan progress
     cancelled()      — checked at every stage boundary and inside every
                        loop so an abandoned run stands down quietly */
export async function extractKeyframeTimes(vid, { onStep = () => {}, cancelled = () => false } = {}){
  const duration = vid.duration;
  const REFINE_MIN = 0.125;     /* s — seek-scan resolution floor; finer adds nothing to a contact sheet */
  const STRONG = 12;            /* worst-block mean abs diff (0..255) clearly above compression flutter */
  let segs, firstPt, frameDur = 0;
  const played = await playScanFrames(vid, onStep, cancelled);
  if(cancelled()) return null;
  if(played){
    segs = played.segs; firstPt = played.firstPt; frameDur = played.frameDur;
  } else {
    const COARSE = Math.max(16, Math.min(64, Math.round(duration)));
    const REFINE = 64;          /* bisection seeks, spent only where change is found */
    const total = COARSE + REFINE;
    const aw = 96, ah = Math.max(1, Math.round(aw * vid.videoHeight / vid.videoWidth));
    const c = document.createElement('canvas'); c.width = aw; c.height = ah;
    const cx = c.getContext('2d', { willReadFrequently: true });
    let step = 0;
    const sampleAt = async (time) => {
      onStep(Math.min(++step, total), total);
      try {
        await seekVideoFrame(vid, time);
        if(cancelled()) return null;
        cx.drawImage(vid, 0, 0, aw, ah);
        return grayFrame(cx, aw, ah);
      } catch (_){ return null; }
    };
    /* coarse pass — whole-clip coverage; segs holds neighbouring sample
       pairs {a:{t,g}, b:{t,g}, score} */
    segs = [];
    let prev = null;
    for(let i = 0; i < COARSE; i++){
      if(cancelled()) return null;
      const cur = { t: duration * (i + 0.5) / COARSE, g: null };
      cur.g = await sampleAt(cur.t);
      if(!firstPt) firstPt = cur;
      if(prev) segs.push({ a: prev, b: cur, score: blockDiff(prev.g, cur.g, aw, ah) });
      prev = cur;
    }
    /* refinement — two priorities per round. (1) Split the biggest scored
       change still wider than the resolution floor: pinpoints known cuts.
       (2) With no scored work left, blind-probe the widest remaining
       interval — a change that begins AND ends inside one interval
       (A→B→A) leaves no endpoint difference for scoring to see, so
       unspent budget goes to shrinking the gaps it could hide in. A
       probe that uncovers a change feeds back into priority 1 next
       round. Only when every interval is at the resolution floor does
       the budget go unspent. */
    const splitAt = async (idx) => {
      const seg = segs[idx];
      const mid = { t: (seg.a.t + seg.b.t) / 2, g: null };
      mid.g = await sampleAt(mid.t);
      /* a failed midpoint sample must NOT split the segment — two
         zero-score halves would erase the only evidence of a real cut;
         mark it instead so the budget isn't burned retrying. */
      if(!mid.g){ seg.noRefine = true; return; }
      segs.splice(idx, 1,
        { a: seg.a, b: mid, score: blockDiff(seg.a.g, mid.g, aw, ah) },
        { a: mid, b: seg.b, score: blockDiff(mid.g, seg.b.g, aw, ah) });
    };
    for(let r = 0; r < REFINE; r++){
      if(cancelled()) return null;
      let best = -1, bestScore = STRONG;
      for(let i = 0; i < segs.length; i++){
        if(segs[i].noRefine || segs[i].b.t - segs[i].a.t < REFINE_MIN * 2) continue;
        if(segs[i].score > bestScore){ bestScore = segs[i].score; best = i; }
      }
      if(best < 0){
        let bestW = REFINE_MIN * 2;
        for(let i = 0; i < segs.length; i++){
          if(segs[i].noRefine) continue;
          const w = segs[i].b.t - segs[i].a.t;
          if(w > bestW){ bestW = w; best = i; }
        }
      }
      if(best < 0) break;
      await splitAt(best);
    }
    if(cancelled()) return null;
  }
  /* How many keyframes? Baseline ~1 per 4 s of footage capped at 16
     (a static lecture doesn't need more); when the clip has MORE
     distinct change MOMENTS than that (fast cuts), grow to strong+2 —
     up to 32, where pack-time thinning guards the ZIP cap. A "strong"
     change clears both the absolute floor and 2× the clip's own mean,
     so uniformly shaky footage doesn't count every step as a cut; and
     a run of consecutive strong pairs counts ONCE — at full-frame
     cadence a half-second scroll is ~30 strong pairs but one action. */
  const mean = segs.length ? segs.reduce((s, x) => s + x.score, 0) / segs.length : 0;
  const thresh = Math.max(STRONG, mean * 2);
  let strong = 0, inRun = false;
  for(const s of segs){ const hit = s.score > thresh; if(hit && !inRun) strong++; inRun = hit; }
  const N = Math.max(6, Math.min(32, Math.max(Math.min(Math.round(duration / 4), 16), strong + 2)));
  /* a change pair contributes its END time — the moment the new
     picture is fully on screen. No-change pairs are dropped: a
     0-score point is just empty footage, and letting it claim a
     slot would crowd out the burst points the later passes exist for
     (static clips fill via the even fallback instead). */
  const scores = segs.map(seg => ({ t: seg.b.t, score: seg.score }))
    .filter(s => s.score > Math.max(3, mean * 0.5))
    .sort((x, y) => y.score - x.score);
  const picked = firstPt && firstPt.g ? [firstPt.t] : [];
  const pickWith = (gap, limit) => {
    const cap = Math.min(N, limit || N);
    for(const s of scores){
      if(picked.length >= cap) break;
      if(picked.every(p => Math.abs(p - s.t) >= gap)) picked.push(s.t);
    }
  };
  /* three passes: duration/N spacing first, which by construction cannot
     spend every slot on one region, so the whole clip stays represented;
     then 0.25 s spacing onto the densest action — a busy second can hold
     several distinct states without letting one burst eat every slot.
     Play scan earns a final frame-spaced pass for transients: a glitch
     and its recovery are two opposite jumps closer together than 0.25 s
     — the middle pass can only ever keep ONE of them, whichever scored
     higher, even when the dropped one outscores everything else it
     accepted. So under play scan the middle pass may not spend the
     last quarter of the slots; the frame-spaced pass uses them to pull
     the transient's other half back in. */
  pickWith(duration / N);
  pickWith(REFINE_MIN * 2, frameDur ? N - Math.ceil(N / 4) : N);
  if(frameDur) pickWith(frameDur * 0.9);
  for(let i = 1; picked.length < N && i <= N; i++){
    const tEven = duration * i / (N + 1);
    if(picked.every(p => Math.abs(p - tEven) >= duration / (N * 2))) picked.push(tEven);
  }
  picked.sort((a, b) => a - b);
  /* play-scan times are exact frame PTS values; seeking back to an
     exact boundary can land on the previous frame through float
     rounding. Half a frame in lands mid-presentation, unambiguous.
     Clamp short of duration itself — an exact-EOF seek may present
     nothing to draw (Safari) or hang the seeked event. */
  return frameDur ? picked.map(p => Math.min(duration - frameDur / 4, p + frameDur / 2)) : picked;
}

/* The whole pipeline: analyze → extract → contact sheet → pack.
     file     a video File/Blob (checked with isVideoFile first).
     options:
       maxBytes    byte cap for the packed ZIP (default DEFAULT_MAX_BYTES;
                   on the site this is the account's upload cap, so the
                   result is guaranteed uploadable)
       onProgress(stage, pct, info)  stage ∈ 'analyze' | 'extract' |
                   'sheet' | 'pack'; pct 0–100 across the whole run;
                   info = { done, total } for the counted stages
       cancelled() polled at every checkpoint; true → resolve null and
                   stand down quietly (the page uses this to let a newer
                   drop supersede a run already in flight)
   Resolves { file, sheet, frameCount, duration }: the ZIP as a File named
   "<source>-frames.zip" (contact-sheet.jpg + frame-N.jpg entries), the
   contact-sheet JPEG Blob, how many frames were kept, and the clip length
   in seconds. Rejects with err.code:
     'format'   — not a video / container not supported by this browser
     'decode'   — metadata never materialized or the stream is corrupt
     'extract'  — no frame could be extracted (also the catch-all: the
                  page folds every unexpected failure into this outcome)
     'zip_size' — even the thinned-to-6 ZIP exceeds maxBytes */
export async function videoToFramesZip(file, options){
  const { maxBytes = DEFAULT_MAX_BYTES, onProgress, cancelled = () => false } = options || {};
  if(!file || !isVideoFile(file)) throw vfail('format');
  const step = (stage, pct, info) => { if(onProgress) onProgress(stage, pct, info); };
  const vid = document.createElement('video');
  /* metadata, not auto: the pipeline drives every read via explicit
     seeks, and with no input-size cap an eager full-file buffer is
     exactly the memory/IO spike we don't want on big sources. */
  vid.preload = 'metadata'; vid.muted = true; vid.playsInline = true;
  const url = URL.createObjectURL(file);
  vid.src = url;
  try {
    try {
      await new Promise((res, rej) => {
        if(vid.readyState >= 1) return res();
        vid.addEventListener('loadedmetadata', res, { once: true });
        vid.addEventListener('error', rej, { once: true });
      });
    } catch (_){
      const unsupported = typeof MediaError !== 'undefined' && vid.error &&
        vid.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
      throw vfail(unsupported ? 'format' : 'decode');
    }
    if(cancelled()) return null;
    /* MediaRecorder-produced webm (screen recordings) can report Infinity
       until forced to materialize a duration. */
    if(!isFinite(vid.duration)){
      await new Promise(res => {
        const giveUp = setTimeout(done, 3000);
        function done(){ clearTimeout(giveUp); vid.removeEventListener('durationchange', onDur); res(); }
        function onDur(){ if(isFinite(vid.duration)) done(); }
        vid.addEventListener('durationchange', onDur);
        try { vid.currentTime = 1e7; } catch (_){ done(); }
      });
    }
    if(cancelled()) return null;
    if(!vid.videoWidth || !isFinite(vid.duration)) throw vfail('decode');
    try {
      const duration = vid.duration;
      /* Stage split across one progress track: analyze 0–45%, extract
         45–85%, sheet/pack fill the rest. */
      const times = await extractKeyframeTimes(vid, {
        cancelled,
        onStep: (i, S) => step('analyze', Math.round(i / S * 45), { done: i, total: S }),
      });
      if(cancelled()) return null;
      if(!times || !times.length) throw vfail('extract');
      try { const p = vid.play(); if(p && p.catch) p.catch(() => {}); vid.pause(); } catch (_){}
      /* Extract + encode one frame at a time, keeping only the compressed
         blob and a capped thumb; the full-size canvas dies with each
         iteration. 32 retained full canvases (~3 MB each for portrait
         video) would otherwise spike past 100 MB. The thumbs exist for
         the contact sheet — an overview, where reduced size is plenty;
         the full-resolution frames are right there in the ZIP. */
      const frames = [];   /* {thumb, blob} */
      for(let i = 0; i < times.length; i++){
        if(cancelled()) return null;
        step('extract', 45 + Math.round((i + 1) / times.length * 40), { done: i + 1, total: times.length });
        try {
          await seekVideoFrame(vid, times[i]);
          if(cancelled()) return null;
          const full = captureVideoFrame(vid, i, times[i]);
          const blob = await new Promise(resolve => full.toBlob(resolve, 'image/jpeg', 0.90));
          if(!blob) continue;
          /* Sheet cells cap at 420 px: half of a 1536 px frame across a
             6-column sheet would push canvas area past Safari's ~16.7 MP
             ceiling. 420 is plenty for an overview — the full-resolution
             frames are right there in the ZIP. */
          const tw = Math.min(420, full.width);
          const thumb = document.createElement('canvas');
          thumb.width = tw;
          thumb.height = Math.max(1, Math.round(full.height * tw / full.width));
          thumb.getContext('2d').drawImage(full, 0, 0, thumb.width, thumb.height);
          frames.push({ thumb, blob });
        } catch (_){}
      }
      if(cancelled()) return null;
      if(!frames.length) throw vfail('extract');
      step('sheet', 88);
      const headerText = (file.name || 'video') + '  |  ' + formatVideoTime(duration) + '  |  ' + vid.videoWidth + '×' + vid.videoHeight;
      let kept = frames;
      let sheetBlob = await new Promise(resolve =>
        buildContactSheet(kept.map(f => f.thumb), headerText).toBlob(resolve, 'image/jpeg', 0.85));
      if(cancelled()) return null;
      if(!sheetBlob) throw vfail('extract');
      step('pack', 94);
      /* If the store-only ZIP would overflow the byte cap, thin to every
         other frame and rebuild the sheet (high-entropy sources at 32
         frames can brush the cap). A store-only ZIP's size is exactly
         computable from blob sizes — 76 header bytes + 2× the name per
         entry, 22 for the end record — so thinning happens BEFORE any
         bytes materialize and the JPEGs are buffered exactly once: at
         1536 px, build-then-measure would spike tens of MB of
         ArrayBuffers per round on mobile Safari. The zip_size error
         stays as the pathological-case backstop. Frame files renumber
         1..n on each pass — the baked-in watermark keeps the original
         index, whose timestamp is the part that matters. */
      const zipSize = () => kept.reduce(
        (s, f, i) => s + 76 + 2 * ('frame-' + (i + 1) + '.jpg').length + f.blob.size,
        22 + 76 + 2 * 'contact-sheet.jpg'.length + sheetBlob.size);
      while(zipSize() > maxBytes && kept.length > 6){
        kept = kept.filter((_, i) => i % 2 === 0);
        sheetBlob = await new Promise(resolve =>
          buildContactSheet(kept.map(f => f.thumb), headerText).toBlob(resolve, 'image/jpeg', 0.85));
        if(cancelled()) return null;
        if(!sheetBlob) throw vfail('extract');
      }
      if(zipSize() > maxBytes) throw vfail('zip_size');
      const entries = [{ name: 'contact-sheet.jpg', data: await sheetBlob.arrayBuffer() }];
      for(let i = 0; i < kept.length; i++){
        if(cancelled()) return null;
        entries.push({ name: 'frame-' + (i + 1) + '.jpg', data: await kept[i].blob.arrayBuffer() });
      }
      if(cancelled()) return null;
      const zipBlob = buildZip(entries);
      const baseName = (file.name || 'video').replace(/\.[^.]+$/, '');
      const zipFile = new File([zipBlob], baseName + '-frames.zip', { type: 'application/zip' });
      return { file: zipFile, sheet: sheetBlob, frameCount: kept.length, duration };
    } catch (e){
      /* the page folds every unexpected failure in this stretch into the
         same "could not extract" outcome; coded errors pass through */
      if(e && e.code) throw e;
      throw vfail('extract');
    }
  } finally {
    try { vid.pause(); } catch (_){}
    URL.revokeObjectURL(url);
  }
}
