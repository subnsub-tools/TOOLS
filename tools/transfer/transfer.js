/* Transfer — direct device-to-device file transfer over WebRTC,
   with pluggable discovery. Engine of the Transfer tool on
   subnsub.com (/transfer), kept in lockstep with the in-page version.

   Layers (mirroring the in-page tool):
   1. Discovery — roster + targeted signal relay (+ an optional byte pipe)
      behind a small callback contract (below). The BroadcastChannel
      implementation ships here: every tab of one browser acts as one LAN, so
      the whole engine runs — and is auditable end-to-end — with no server at
      all. The production WebSocket discovery implements the same contract
      against a rooming server; its wire shape is documented in README.md
      (the implementation is server-bound and stays with the site).
   2. Peer — one per remote device: an RTCPeerConnection + a single ordered
      data channel (created by the side with the smaller id, so there is
      never offer glare) + the chunked-transfer engine + the roads that run
      beside the channel (below).
   3. TransferNode — the coordinator: owns the discovery sessions (your own
      room, plus any rooms you dial), the peer table, suspended-transfer
      state and first-contact trust. Presentation is a set of optional
      callbacks (`ui`) — this module never touches the DOM or storage, and
      its only network surfaces are WebRTC and whatever transports you
      inject (relay ICE servers, a link store, a tunnel provider).

   Data-channel protocol (string frames are JSON control, binary frames are
   file bytes; the channel is ordered, so chunk order is send order):
     caps {t,mp:1}                            exchanged on open — "I read offset-framed data"
     meta {t,id,name,size,mime,r:1,mp?,tk?,tt?} offer one file (mp:1 = its frames carry offsets)
     ready {t,id,off?,tk?}                    receiver's go — off = resume offset
     awaiting {t,id}                          receiver is at its accept gate
     trust {t,tok}                            first-contact trust token grant
     pause {t,id} / resume {t,id}             receive-side backpressure
     done {t,id} / received {t,id}            sender's EOF / receiver's receipt
     cancel {t,id}                            either side aborts

   Flow control: the sender stops pushing while dc.bufferedAmount sits over
   HIGH_WATER and resumes on bufferedamountlow (LOW_WATER); the receiver
   additionally holds the sender with pause/resume frames while its sink's
   un-settled write queue exceeds RECV_HIGH — the disk-slower-than-wire case.

   Resume: when a connection dies mid-transfer the work is parked, not
   failed — the sender keeps the File handles + queue, the receiver keeps
   its OPEN sink — keyed by the peer's stable device id for RESUME_GRACE.
   When the same device reconnects, the sender re-offers each file under its
   original item id and the receiver answers ready{off:<bytes settled>}, so
   the stream picks up mid-file instead of starting over. The public device
   id alone is never proof (any room member could claim it): each transfer
   carries a secret token (tk) that only ever travelled the original
   DTLS-private channel, and each resume direction must prove knowledge of
   it before a byte moves.

   No direct route: a transfer must still succeed. Once the STUN-only
   attempt is judged dead (connectionState failed, or FALLBACK_MS with no
   channel) every fallback leg starts at the same instant and the first to
   come up carries the file — a relay-backed ICE restart (TURN, when
   `relayIceServers` is given), the discovery session's byte pipe
   (PipeChannel: sealed with session ids, ordered frames and end-to-end
   AES-GCM, so the relay in the middle forwards ciphertext only), an
   encrypted upload link (when a `link` store is given) and a tunnel through
   a machine one side can reach (when a `tunnel` provider is given).

   The multipath race: every road that comes up is KEPT beside the WebRTC
   channel rather than torn down for losing the sprint to connect, and the
   roads go up as soon as two devices are paired. A file is then streamed
   down all of them at once, each frame stamped with its offset, and the
   receiver writes only what is past its mark: the fastest road sets the
   finish time, and a road that dies mid-file costs nothing because the
   others carried the same bytes all along. The price, accepted
   deliberately, is that a file leaves the device once per road. Nothing is
   raced until the far end answers `caps`, so an older build gets exactly
   the single-channel protocol it understands.

   File bytes ride the DTLS-encrypted RTCDataChannel, device-to-device —
   discovery relays only the small SDP/ICE handshake (and, on the pipe leg,
   ciphertext it cannot read). iceServers defaults to [] (no STUN/TURN
   lookups, host candidates only), which confines connectivity to the local
   network; pass STUN servers to cross NATs and relayIceServers for the
   TURN leg of the fallback. */

/* ---- transfer engine tuning (same values as the in-page build) ---- */
const PREFERRED_CHUNK = 256 * 1024, MIN_CHUNK = 16 * 1024;
const HIGH_WATER = 8 * 1024 * 1024, LOW_WATER = 1 * 1024 * 1024;
const RECV_HIGH = 16 * 1024 * 1024, RECV_LOW = 4 * 1024 * 1024;
/* keep a broken transfer resumable this long — sender holds the File + queue,
   receiver holds its open sink; past it, fail + release */
export const RESUME_GRACE = 5 * 60 * 1000;
/* refuse past ~2GB on the in-memory fallback sink — never silently OOM */
export const MEM_HARD_CAP = 2 * 1024 * 1024 * 1024;
/* stuck this long with no channel = direct is judged dead → every fallback starts */
export const FALLBACK_MS = 15000;
/* a relay-backed ICE attempt that hasn't connected in this long counts as a
   dead leg (the pc keeps trying underneath) */
const TURN_LEG_MS = 30000;
/* a peer-shared relay credential is held at most this long, whatever it claims */
const RELAY_SHARED_MAX_MS = 4 * 3600 * 1000;

/* ---- multipath race ----
   Every road that comes up stays up, and the SAME file goes down all of
   them at once; the receiver keeps one sink and writes only what is past
   its high-water mark, so the fastest road sets the finish time and the
   slower ones cost bandwidth, not correctness. That needs every data frame
   to say where it belongs — a plain chunk is only meaningful in the order
   one channel sent it — so a raced frame is [8 bytes offset LE][4 bytes
   file tag LE][payload]. Both ends must agree first (an older build would
   write the header into the file): the `caps` control frame is exchanged
   the moment a channel opens, and only a peer that answered it is ever
   sent framed data. */
export const MP_HDR = 12;
const CAPS_WAIT_MS = 8000;   /* a peer that has not answered `caps` by now is an older build: its lanes are let go and it gets the single-channel protocol it understands */
/* The tag is what stops the LAST frame of the file just finished — still in
   flight on a road that was cut mid-frame when a faster one won — from being
   trimmed into the NEXT file's sink, where it would straddle the mark and
   corrupt it. */
export function mpFrame(off, chunk, tag) { const out = new Uint8Array(MP_HDR + chunk.byteLength); const dv = new DataView(out.buffer); dv.setFloat64(0, off, true); dv.setUint32(8, tag >>> 0, true); out.set(new Uint8Array(chunk), MP_HDR); return out.buffer; }
function mpOff(buf) { try { return new DataView(buf, 0, MP_HDR).getFloat64(0, true); } catch { return NaN; } }
function mpTag(buf) { try { return new DataView(buf, 0, MP_HDR).getUint32(8, true); } catch { return -1; } }
/* The tag a file's frames carry, derived from the id both ends already
   share — never sent, so there is nothing to disagree about. */
export function mpTagOf(id) { const n = parseInt(String(id || '').slice(0, 8), 16); return Number.isFinite(n) ? (n >>> 0) : 0; }
/* What a raced frame contributes to a file that is complete up to `mark`.
   'bad' = a frame no honest sender would emit (past the end, negative,
   fractional) and the receive is torn down; null = nothing new (a slower
   road repeating bytes already on disk); otherwise the bytes to write and
   the mark they carry it to. A frame that straddles the mark is trimmed to
   its new part, so the sink only ever sees the file in order, once. */
export function mpTake(mark, size, buf, tag) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength <= MP_HDR) return null;
  if (mpTag(buf) !== (tag >>> 0)) return null;   /* a frame of some other file — a road cut mid-frame when the last one ended */
  const off = mpOff(buf), len = buf.byteLength - MP_HDR, end = off + len;
  if (!Number.isFinite(off) || !Number.isInteger(off) || off < 0 || end > size) return 'bad';
  if (end <= mark) return null;      /* wholly behind the mark */
  if (off > mark) return null;       /* a hole: no road skips ahead, so this frame cannot be placed */
  return { data: buf.slice(MP_HDR + (mark - off)), mark: end };
}

/* ---- helpers ---- */
function randHex(n) { const b = crypto.getRandomValues(new Uint8Array(n)); let o = ''; for (let i = 0; i < n; i++) o += b[i].toString(16).padStart(2, '0'); return o; }
/* A friendly default device name — real machine/host names aren't exposed to
   web pages (privacy), so pick a memorable random label instead. */
export function deviceLabel() {
  const adj = ['quiet', 'amber', 'cobalt', 'lucky', 'brisk', 'sunny', 'noble', 'swift', 'mossy', 'plum'];
  const noun = ['otter', 'finch', 'maple', 'comet', 'pebble', 'willow', 'lynx', 'heron', 'cedar', 'koi'];
  const r = crypto.getRandomValues(new Uint8Array(2));
  return adj[r[0] % adj.length] + '-' + noun[r[1] % noun.length];
}
/* Pairing code: 6 chars from an unambiguous alphabet (no 0/1/i/l/o). It's the
   shared room name for manual pairing, so it must match the signalling
   server's code grammar ([a-z0-9_-]{6,64}). The plain % draw is deliberate
   and kept byte-identical with the in-page build: with 31 symbols the first
   eight are ~12% more likely than the rest, which is cosmetic for a
   discovery room label — the code is not a secret and grants nothing by
   itself (transfers still pass the accept gate and the tk/tt proofs). */
const CODE_ALPHA = '23456789abcdefghjkmnpqrstuvwxyz';
export const CODE_LEN = 6;
export function genCode() { const r = crypto.getRandomValues(new Uint8Array(CODE_LEN)); let s = ''; for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHA[r[i] % CODE_ALPHA.length]; return s; }
export function cleanCode(c) { return String(c || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64); }
/* The sixth character connects: typing the last character of someone's
   code IS the intent, so a code entry needs no confirm step. Given whatever
   the user has typed so far, returns the cleaned code once exactly CODE_LEN
   clean characters are in hand — the moment to dial — and '' before that.
   Longer input is not a typed code (the entry is capped at CODE_LEN; a
   longer code only ever arrives whole, as a pair link — see pairLinkCode). */
export function codeComplete(input) { const c = cleanCode(input); return c.length === CODE_LEN ? c : ''; }
/* A pair link (…/transfer#c=<code>) hands over its code whole: 6–64 chars
   of the code grammar in the fragment's `c` field, or '' when there is none.
   A pasted link is read this way before anything is typed into the entry —
   otherwise its first six letters ("https:") would dial a room. */
export function pairLinkCode(text) {
  const s = String(text || '');
  const hashAt = s.indexOf('#');
  if (hashAt < 0) return '';
  const m = s.slice(hashAt + 1).match(/(?:^|&)c=([a-z0-9_-]{6,64})(?:&|$)/i);
  return m ? cleanCode(m[1]) : '';
}
function b64u(buf) { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let t = ''; for (let i = 0; i < u.length; i++) t += String.fromCharCode(u[i]); return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64uDec(t) { if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(t)) return null; try { const b = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - t.length % 4) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; } catch { return null; } }

/* A device's stable id rides as the announced name's 4th segment,
   US-delimited (US never appears in a name). Discovery ids rotate on every
   (re)connect, so they alone can't say "that's the same machine that was
   mid-transfer" — the device id can: it keys resume state, keeps channel
   ownership from flipping on reconnect (glare), and filters our own
   stale-connection ghost from the roster. The in-page build rides its tile
   accent colours in the two middle segments; they stay empty here so the
   two builds parse each other's frames. */
const NAME_SEP = String.fromCharCode(31);
function devOk(v) { return typeof v === 'string' && /^[a-z0-9]{8,16}$/.test(v); }
/* Clamp the display segment to 40 — the transport may cap the whole framed
   payload much higher, so a crafted peer could otherwise send a huge name. */
function parsePeerName(raw) { const s = String(raw == null ? '' : raw); const i = s.indexOf(NAME_SEP); if (i < 0) return { name: (s || 'device').slice(0, 40), dev: '' }; const rest = s.slice(i + 1).split(NAME_SEP); return { name: (s.slice(0, i) || 'device').slice(0, 40), dev: devOk(rest[2]) ? rest[2] : '' }; }

/* Did THIS pc's selected pair go through a relay? Used only to name the road
   a channel took (ui.peerRoads): a credential in the config says a relay
   was OFFERED, not that it carried the path. The `nominated` flag is NOT
   selection — several stale pairs can carry it — so it is trusted only when
   exactly one succeeded pair exists at all. Fail-open to false. */
async function usingRelay(pc) {
  if (!pc || typeof pc.getStats !== 'function') return false;
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => { if (!pair && s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId) || null; });
    if (!pair) {
      let sel = null, succeeded = 0; const nominated = [];
      stats.forEach((s) => {
        if (s.type !== 'candidate-pair' || s.state !== 'succeeded') return;
        succeeded++;
        if (s.selected) sel = sel || s;
        else if (s.nominated) nominated.push(s);
      });
      pair = sel || (succeeded === 1 && nominated.length === 1 ? nominated[0] : null);
    }
    if (!pair) return false;
    const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
    return !!((l && l.candidateType === 'relay') || (r && r.candidateType === 'relay'));
  } catch { return false; }
}

/* ===================================================================== *
 *  1½. RECEIVE SINKS — where an incoming file's bytes land.
 *
 *  A sink is { write(buf), close(), abort() } (all awaitable). Tiered by
 *  capability so a multi-GB file never has to accumulate in memory:
 *    • FSASink — wraps a File System Access writable (desktop Chromium).
 *        True streaming to a real file, constant memory, TB-scale.
 *    • MemSink — in-memory Blob assembly; the default openSink hard-caps
 *        it (MEM_HARD_CAP) so it declines instead of silently OOM-ing.
 *  (The in-page build can slot a disk-backed chunk store between the two;
 *  it's storage-bound, so it stays with the site. Any object with the same
 *  three methods plugs in through the openSink option.)
 *  Receive-side backpressure (pause/resume + RECV_HIGH/LOW) keeps the
 *  write queue bounded when the disk is slower than the wire.
 * ===================================================================== */

export const supportsFSA = () => { try { return typeof window.showSaveFilePicker === 'function' && typeof window.showDirectoryPicker === 'function'; } catch { return false; } };

/* Stream into a chosen directory handle without clobbering an existing
   same-named file: getFileHandle(create:true) truncates on collision, so
   probe the directory (and names reserved by concurrent transfers this
   session) and bump "name (2).ext" until free. Returns a writable — wrap it
   in an FSASink. */
const _reserved = new Set();
export async function fileWritableInDir(dir, name) {
  const safe = String(name || 'file').replace(/[\/\\]/g, '_').replace(/^\.+/, '') || 'file';
  const dot = safe.lastIndexOf('.'), stem = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
  const taken = async (n) => { if (_reserved.has(n)) return true; try { await dir.getFileHandle(n, { create: false }); return true; } catch { return false; } };
  let candidate = safe, i = 2;
  while (await taken(candidate)) { candidate = stem + ' (' + i + ')' + ext; i++; }
  _reserved.add(candidate);
  const fh = await dir.getFileHandle(candidate, { create: true });
  return fh.createWritable();
}

export class FSASink {
  constructor(writable) { this.w = writable; }
  write(buf) { return this.w.write(buf); }
  close() { return this.w.close(); }
  async abort() { try { await this.w.abort(); } catch {} }
}
/* Last-resort sink: assemble the file in memory and hand the finished Blob
   to `deliver(blob, name)` on close (the demo downloads it; an app might
   preview it instead). The Blob also stays readable at sink.blob. */
export class MemSink {
  constructor(name, mime, deliver) { this.name = name; this.mime = mime; this.parts = []; this.deliver = deliver || null; this.blob = null; }
  async write(buf) { this.parts.push(buf); }
  async close() { const blob = new Blob(this.parts, { type: this.mime }); this.parts = []; this.blob = blob; if (this.deliver) this.deliver(blob, this.name); }
  async abort() { this.parts = []; }
}

/* Release a receive's sink only AFTER its queued writes settle, so an
   abort's cleanup can't race an in-flight write. Detaches the sink first so
   no further chunk is written to it. (Module-level: both a live Peer and
   the suspended-transfer expiry need it.) */
function releaseSink(rec) {
  if (!rec || !rec.sink) return;
  const s = rec.sink; rec.sink = null;
  rec.chain = (rec.chain || Promise.resolve()).catch(() => {}).then(() => s.abort()).catch(() => {});
}

/* ===================================================================== *
 *  1. DISCOVERY
 *
 *  A discovery session emits:
 *    onWelcome(selfId, peers[], room)  — you're in: your transport id +
 *                                        the current roster [{id, name}]
 *    onPeerJoined({id, name})          — someone arrived
 *    onPeerLeft(id)                    — someone left
 *    onSignal(from, payload)           — a targeted signal relayed to you
 *    onPipe(from, buf)                 — a binary pipe frame relayed to you
 *                                        (optional: the relay-pipe leg)
 *    onClose(err)                      — the session died
 *  and accepts:
 *    signal(to, payload)               — relay a payload to one peer
 *    pipe(to, frame) → bool            — relay a binary frame to one peer
 *                                        (optional; absent = no pipe leg)
 *    close()                           — leave
 *  Ids are transport-assigned, PIPE_ID_LEN chars, and rotate per
 *  (re)connect; the stable device id rides the name frame instead (see
 *  NAME_SEP above). A pipe frame is [PIPE_ID_LEN bytes id][kind][session
 *  id][payload]: the sender fills the id slot with the TARGET, the relay
 *  swaps in the SENDER before delivery, and forwards nothing else.
 * ===================================================================== */

/* Serverless discovery: every tab of one browser is one "LAN". */
export function BroadcastChannelDiscovery(name, code) {
  const self = { onWelcome: null, onPeerJoined: null, onPeerLeft: null, onSignal: null, onPipe: null, onClose: null };
  /* code mode gets its own channel so paired tabs only meet tabs using the
     SAME code (mirrors the production per-code room); no-code tabs share one
     channel. */
  const bc = new BroadcastChannel(code ? ('lan-discovery:' + code) : 'lan-discovery');
  const selfId = randHex(4);
  const seen = new Set();
  bc.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.from === selfId) return;
    if (m.d === 'hello') {
      bc.postMessage({ d: 'hi', from: selfId, name, to: m.from });
      if (!seen.has(m.from)) { seen.add(m.from); self.onPeerJoined && self.onPeerJoined({ id: m.from, name: m.name }); }
    } else if (m.d === 'hi' && m.to === selfId) {
      if (!seen.has(m.from)) { seen.add(m.from); self.onPeerJoined && self.onPeerJoined({ id: m.from, name: m.name }); }
    } else if (m.d === 'bye') {
      if (seen.delete(m.from)) self.onPeerLeft && self.onPeerLeft(m.from);
    } else if (m.d === 'sig' && m.to === selfId) {
      self.onSignal && self.onSignal(m.from, m.payload);
    } else if (m.d === 'pipe' && m.to === selfId) {
      self.onPipe && self.onPipe(m.from, m.buf);
    }
  };
  setTimeout(() => { self.onWelcome && self.onWelcome(selfId, [], 'local'); bc.postMessage({ d: 'hello', from: selfId, name }); }, 0);
  /* JSON-roundtrip: structured clone (BroadcastChannel) can't clone native
     RTCSessionDescription/RTCIceCandidate, but JSON.stringify invokes their
     toJSON() — matching what a WebSocket transport's send(JSON…) does. */
  self.signal = (to, payload) => bc.postMessage({ d: 'sig', from: selfId, to, payload: JSON.parse(JSON.stringify(payload)) });
  /* same wire shape as the rooming server: the header's id slot carries the SENDER by the time it arrives */
  self.pipe = (to, frame) => { const buf = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength); const u = new Uint8Array(buf); for (let i = 0; i < PIPE_ID_LEN; i++) u[i] = selfId.charCodeAt(i); try { bc.postMessage({ d: 'pipe', from: selfId, to, buf }); return true; } catch { return false; } };
  self.close = () => { try { bc.postMessage({ d: 'bye', from: selfId }); bc.close(); } catch {} };
  return self;
}

/* ===================================================================== *
 *  1¾. RELAY PIPE — an RTCDataChannel look-alike over a byte relay.
 *
 *  One of the fallback legs (Peer._fallback), and a road in the multipath
 *  race. Frames ride the discovery session's `pipe()` (the production
 *  build: the two devices' signalling sockets through the room's relay) as
 *  binary messages: [PIPE_ID_LEN bytes peer id][1 byte kind][4 bytes
 *  session id][payload] — the relay swaps the target id for the sender's
 *  and forwards, nothing else. The transfer engine drives it exactly like
 *  a data channel (send / bufferedAmount / bufferedamountlow / onmessage /
 *  close), so meta, chunks, pause/resume and mid-file resume all work
 *  unchanged over it. The same class rides the tunnel leg over a TunWire.
 *
 *  Flow control is ours (the relay has no backpressure API): every DATA/TEXT
 *  frame is acked by the far end with its byte count, at most PIPE_WINDOW
 *  bytes are unacked in flight (that bounds what the relay buffers per
 *  pipe), the rest queues here and counts toward bufferedAmount so the
 *  engine's HIGH/LOW water marks keep working. No ack for PIPE_ACK_MS = the
 *  pipe is dead (the relay drops frames for a peer that left).
 *
 *  Handshake: initiator knocks (OPEN, retried) → responder ACK_OPENs but
 *  keeps its WebRTC attempt alive → initiator decides (a data channel that
 *  opened meanwhile wins: CLOSE, unless the pair races, in which case the
 *  pipe joins as a lane) or COMMITs → both bind the pipe. A relay that
 *  doesn't carry binary frames silently drops the knock, so it simply
 *  times out there and the other legs carry on.
 *
 *  Sealed: every frame carries a 4-byte session id (a stale or replayed
 *  frame from an earlier knock can't touch a newer pipe), the frame kind +
 *  session id are AES-GCM additional data, and the receiver accepts only
 *  the exact next counter — so a node in the middle can no longer
 *  drop-and-replay an equal-length chunk into a file that then reports
 *  success. Every exit (fail, abandon, lost, close) says CLOSE for its
 *  session, and a fresh knock replaces a stale pair on both ends. Per-peer
 *  consent on the relay side (forward bulk frames only between a pair that
 *  completed OPEN/ACK_OPEN/COMMIT, under a budget) is the relay's job and
 *  stays with the server — the README states the contract.
 * ===================================================================== */
export const PIPE = { OPEN: 1, ACK_OPEN: 2, COMMIT: 3, DATA: 4, TEXT: 5, ACK: 6, CLOSE: 7 };
export const PIPE_ID_LEN = 8;           /* peer ids are 8 chars (randHex(4) here; the rooming server's ids match) */
const PIPE_SID_LEN = 4;                 /* per-attempt session id */
export const PIPE_HDR = PIPE_ID_LEN + 1 + PIPE_SID_LEN;
const PIPE_CHUNK = 256 * 1024;          /* max payload per frame — the production relay caps a frame at 1 MiB */
const PIPE_WINDOW = 4 * 1024 * 1024;    /* unacked bytes allowed in flight */
const PIPE_OPEN_MS = 8000, PIPE_OPEN_RETRY_MS = 1500, PIPE_COMMIT_MS = 10000, PIPE_ACK_MS = 20000;
const pipeEnc = new TextEncoder(), pipeDec = new TextDecoder();
function pipeFrame(to, kind, sid, payload) {
  if (typeof to !== 'string' || to.length !== PIPE_ID_LEN || !sid || sid.byteLength !== PIPE_SID_LEN) return null;
  const src = payload ? (payload instanceof ArrayBuffer ? new Uint8Array(payload) : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)) : null;
  const f = new Uint8Array(PIPE_HDR + (src ? src.byteLength : 0));
  for (let i = 0; i < PIPE_ID_LEN; i++) f[i] = to.charCodeAt(i) & 0x7f;
  f[PIPE_ID_LEN] = kind;
  f.set(sid, PIPE_ID_LEN + 1);
  if (src) f.set(src, PIPE_HDR);
  return f;
}
function pipeSid(buf) { return new Uint8Array(buf.slice(PIPE_ID_LEN + 1, PIPE_ID_LEN + 1 + PIPE_SID_LEN)); }
function sidEq(a, b) { if (!a || !b || a.byteLength !== b.byteLength) return false; for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false; return true; }

export class PipeChannel {
  constructor(app, peerId, initiator, sid, wire) {
    this.app = app; this.peerId = peerId; this.initiator = initiator;
    /* wire: where frames go. null = the discovery session's pipe (the relay
       pipe); a TunWire = the tunnel leg. via names the road. */
    this.wire = wire || null; this.via = wire ? 'tunnel' : 'pipe';
    this.sid = sid || crypto.getRandomValues(new Uint8Array(PIPE_SID_LEN));   /* initiator mints; responder adopts the knock's */
    this.readyState = 'connecting'; this.binaryType = 'arraybuffer';
    this.bufferedAmount = 0; this.bufferedAmountLowThreshold = 0;
    this.onopen = null; this.onclose = null; this.onmessage = null;
    this.onfail = null;   /* never came up (no ack / refused / socket gone) — distinct from onclose, which is a LIVE pipe dying */
    this.hook = null;     /* Peer's adopt-or-refuse decision at ack (initiator) / commit (responder); returns true to adopt */
    this._ls = Object.create(null);
    this._q = []; this._inflight = 0; this._reserved = 0; this._sent = []; this._below = true;
    this._openTimer = null; this._retryTimer = null; this._commitTimer = null; this._ackTimer = null;
    /* End-to-end encryption: the knock / ack carry ephemeral ECDH P-256
       public keys; both ends derive one AES-256-GCM key and every DATA /
       TEXT payload goes over as [8-byte counter][ciphertext], with the
       frame kind + session id as additional authenticated data. The relay
       in the middle forwards ciphertext only (it could still swap keys —
       it is the operator's own infrastructure; what it cannot do is read,
       reorder or replay a transfer in passing: the receiver insists on the
       exact next counter). Nonce = direction byte + per-direction counter,
       so the two senders never collide. */
    this._kp = null; this._key = null; this._pub = null; this._dir = initiator ? 1 : 2;
    this._txChain = Promise.resolve(); this._rxChain = Promise.resolve(); this._txCount = 0; this._rxCount = 0n;
    this._accepting = false; this._deriving = false;
  }
  static supported() { try { return !!(crypto && crypto.subtle && typeof crypto.subtle.deriveBits === 'function'); } catch { return false; } }
  addEventListener(ev, f) { (this._ls[ev] || (this._ls[ev] = new Set())).add(f); }
  removeEventListener(ev, f) { const l = this._ls[ev]; if (l) l.delete(f); }
  _emit(ev) { const l = this._ls[ev]; if (!l) return; for (const f of [...l]) { try { f({ type: ev, target: this }); } catch {} } }
  _raw(kind, payload) { const f = pipeFrame(this.peerId, kind, this.sid, payload); if (!f) return false; return this.wire ? this.wire.send(f) : !!this.app._pipeSend(this.peerId, f); }
  _aad(kind) { const a = new Uint8Array(1 + PIPE_SID_LEN); a[0] = kind; a.set(this.sid, 1); return a; }
  _clearTimers() { for (const k of ['_openTimer', '_retryTimer', '_commitTimer', '_ackTimer']) { if (this[k]) { clearTimeout(this[k]); this[k] = null; } } }
  async _keys() { this._kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); this._pub = new Uint8Array(await crypto.subtle.exportKey('raw', this._kp.publicKey)); return this._pub; }
  async _derive(peerPub) {
    const pub = await crypto.subtle.importKey('raw', peerPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, this._kp.privateKey, 256);
    this._key = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  _nonce(dir, counterBytes) { const n = new Uint8Array(12); n[0] = dir; n.set(counterBytes, 4); return n; }
  /* initiator: knock (with our public key) until the far end acks, or the knock window closes */
  open() {
    if (this.readyState !== 'connecting') return;
    this._openTimer = setTimeout(() => this._fail(), PIPE_OPEN_MS);
    this._keys().then((pub) => {
      if (this.readyState !== 'connecting') return;
      const knock = () => { if (this.readyState !== 'connecting') return; if (!this._raw(PIPE.OPEN, pub)) { this._fail(); return; } this._retryTimer = setTimeout(knock, PIPE_OPEN_RETRY_MS); };
      knock();
    }).catch(() => this._fail());
  }
  /* responder: the knock carries the initiator's public key — derive, ack with ours, then wait for the commit */
  accept(buf) {
    if (this.readyState !== 'connecting') return;
    if (this._key) { this._raw(PIPE.ACK_OPEN, this._pub); return; }   /* their retry crossed our ack → ack again */
    if (this._accepting) return;
    this._accepting = true;
    const peerPub = new Uint8Array(buf.slice(PIPE_HDR));
    if (peerPub.byteLength !== 65) { this._fail(); return; }
    this._keys().then(async (pub) => {
      await this._derive(peerPub);
      if (this.readyState !== 'connecting') return;
      if (!this._raw(PIPE.ACK_OPEN, pub)) { this._fail(); return; }
      if (!this._commitTimer) this._commitTimer = setTimeout(() => this._fail(), PIPE_COMMIT_MS);
    }).catch(() => this._fail());
  }
  /* every exit says goodbye (best effort, scoped to this session id) so the relay and the far end drop their half of THIS attempt and a fresh knock can start clean */
  _fail() { if (this.readyState !== 'connecting') return; this._clearTimers(); this.readyState = 'closed'; this._raw(PIPE.CLOSE); if (this.onfail) { try { this.onfail(); } catch {} } }
  abandon() { if (this.readyState === 'closed') return; this._clearTimers(); this.readyState = 'closed'; this._raw(PIPE.CLOSE); }
  _becomeOpen() { this._clearTimers(); this.readyState = 'open'; if (this.onopen) { try { this.onopen({ type: 'open', target: this }); } catch {} } }
  /* an incoming frame already addressed to us: [id from][kind][4 sid][payload] — other sessions' frames are not ours */
  onFrame(kind, buf) {
    if (buf.byteLength < PIPE_HDR || !sidEq(pipeSid(buf), this.sid)) return;
    if (kind === PIPE.ACK_OPEN) {
      if (!this.initiator || this.readyState !== 'connecting' || this._key || this._deriving || !this._kp) return;
      const peerPub = new Uint8Array(buf.slice(PIPE_HDR));
      if (peerPub.byteLength !== 65) { this._fail(); return; }
      this._deriving = true;
      this._derive(peerPub).then(() => {
        if (this.readyState !== 'connecting') return;
        this._clearTimers();
        const adopt = this.hook ? this.hook(this) : false;
        if (adopt) { if (this._raw(PIPE.COMMIT)) this._becomeOpen(); else this._closed(); }   /* adopted but the socket just died: the peer already switched to us — go down as a live channel (onclose → reset → resume), not as a failed knock */
        else this.abandon();
      }).catch(() => this._fail());
      return;
    }
    if (kind === PIPE.COMMIT) {
      if (this.initiator || this.readyState !== 'connecting' || !this._key) return;
      const adopt = this.hook ? this.hook(this) : false;
      if (adopt) this._becomeOpen(); else this.abandon();
      return;
    }
    if (kind === PIPE.CLOSE) { if (this.readyState === 'connecting') { this._clearTimers(); this.readyState = 'closed'; if (this.onfail) { try { this.onfail(); } catch {} } } else this._closed(); return; }
    if (this.readyState !== 'open') return;
    if (kind === PIPE.ACK) {
      if (buf.byteLength !== PIPE_HDR + 4) return;
      const n = new DataView(buf, PIPE_HDR, 4).getUint32(0, true);
      const e = this._sent.shift();
      if (!e || e.wire !== n) { this._lost(); return; }   /* acks come back one per frame, in order — anything else is a desync */
      this._inflight = Math.max(0, this._inflight - e.wire);
      this.bufferedAmount = Math.max(0, this.bufferedAmount - e.plain);
      if (this._ackTimer) { clearTimeout(this._ackTimer); this._ackTimer = null; }
      this._drain();
      if (!this._below && this.bufferedAmount <= this.bufferedAmountLowThreshold) { this._below = true; this._emit('bufferedamountlow'); }
      return;
    }
    if (kind === PIPE.DATA || kind === PIPE.TEXT) {
      const n = buf.byteLength - PIPE_HDR;
      const ack = new Uint8Array(4); new DataView(ack.buffer).setUint32(0, n, true);
      this._raw(PIPE.ACK, ack);   /* flow control acks the wire bytes on arrival — decryption is local work */
      const body = buf.slice(PIPE_HDR);
      this._rxChain = this._rxChain.then(async () => {
        if (this.readyState !== 'open') return;
        if (body.byteLength < 8 + 16) throw new Error('short');
        const counter = new DataView(body, 0, 8).getBigUint64(0);
        if (counter !== this._rxCount) throw new Error('out of order');   /* exactly the next frame or nothing: no gaps, no repeats, no reordering */
        this._rxCount = counter + 1n;
        const nonce = this._nonce(this._dir === 1 ? 2 : 1, new Uint8Array(body, 0, 8));
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: this._aad(kind) }, this._key, new Uint8Array(body, 8));
        if (!this.onmessage || this.readyState !== 'open') return;
        const data = kind === PIPE.DATA ? plain : pipeDec.decode(plain);
        try { this.onmessage({ data, target: this }); } catch {}
      }).catch(() => this._lost());   /* a frame that doesn't authenticate, or arrives out of sequence = tampering or desync — the channel is dead */
    }
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('pipe not open');
    let kind, plain;
    if (typeof data === 'string') { kind = PIPE.TEXT; plain = pipeEnc.encode(data); }
    else { kind = PIPE.DATA; plain = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
    if (plain.byteLength > PIPE_CHUNK * 2) throw new Error('pipe frame too large');
    this._q.push({ kind, plain });
    this.bufferedAmount += plain.byteLength;
    if (this.bufferedAmount > this.bufferedAmountLowThreshold) this._below = false;
    this._drain();
  }
  _drain() {
    if (this.readyState !== 'open') return;
    while (this._q.length && (this._inflight + this._reserved === 0 || this._inflight + this._reserved + this._q[0].plain.byteLength + 24 <= PIPE_WINDOW)) {
      const f = this._q.shift(), est = f.plain.byteLength + 24;
      this._reserved += est;
      this._txChain = this._txChain.then(async () => {
        if (this.readyState !== 'open') return;
        const counter = new Uint8Array(8); new DataView(counter.buffer).setBigUint64(0, BigInt(this._txCount++));
        const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: this._nonce(this._dir, counter), additionalData: this._aad(f.kind) }, this._key, f.plain));
        const wire = new Uint8Array(8 + cipher.byteLength); wire.set(counter, 0); wire.set(cipher, 8);
        this._reserved = Math.max(0, this._reserved - est);
        if (this.readyState !== 'open') return;
        if (!this._raw(f.kind, wire)) { this._lost(); return; }
        this._inflight += wire.byteLength; this._sent.push({ plain: f.plain.byteLength, wire: wire.byteLength });
        this._drain();
      }).catch(() => this._lost());
    }
    if ((this._inflight > 0 || this._reserved > 0) && !this._ackTimer) this._ackTimer = setTimeout(() => { this._ackTimer = null; if (this._inflight > 0) this._lost(); else if (this._reserved > 0 || this._q.length) this._drain(); }, PIPE_ACK_MS);
  }
  close() { if (this.readyState === 'closed') return; if (this.readyState === 'connecting') { this.abandon(); return; } this._closed(); }
  /* the socket under us (or the peer) is gone — a goodbye is attempted anyway (it costs nothing when it can't be sent) */
  _lost() { if (this.readyState === 'connecting') this._fail(); else this._closed(); }
  _closed() {
    if (this.readyState === 'closed') return;
    this._clearTimers(); this.readyState = 'closed'; this._q = []; this._sent = []; this._inflight = 0; this._reserved = 0;
    this._raw(PIPE.CLOSE);
    if (this.onclose) { try { this.onclose({ type: 'close', target: this }); } catch {} }
    this._emit('close');
  }
  static refuse(app, peerId, sid, wire) { const f = pipeFrame(peerId, PIPE.CLOSE, sid); if (!f) return; if (wire) wire.send(f); else app._pipeSend(peerId, f); }
}

/* ===================================================================== *
 *  1⅞. TUNNEL — the fourth leg, as an injectable transport.
 *
 *  A machine that one side can already reach through an end-to-end
 *  encrypted tunnel couples the two browsers' byte streams. Only one side
 *  needs such a machine: the HOST is whichever side has one, the GUEST
 *  makes an ephemeral key, learns the machine's address over signalling
 *  and dials in with a hello that names the session and nothing else.
 *  Over the two streams ride exactly the relay pipe's frames (PipeChannel
 *  with a TunWire instead of the discovery pipe): same knock/ack/commit,
 *  same ECDH + AES-GCM end to end, same flow control. The machine — like
 *  the relay on the pipe leg — forwards ciphertext it cannot read, and a
 *  guest can reach nothing but the one peer that invited it.
 *
 *  The machine, its tunnel library, key enrolment, one-node-per-key
 *  locking and leases are the host application's business (in the hosted
 *  build: the Monitor helper's direct mode); the engine only needs the
 *  `tunnel` provider contract in README.md. Framing on the byte stream is
 *  [4 bytes LE length][frame]; a length of zero is a keepalive, sent while
 *  a channel is idle so the machine's silence deadline never cuts a link
 *  that is merely quiet. The leg is for reaching, not speed, and it races
 *  the other legs like any of them.
 * ===================================================================== */
const TUN_HELLO_MS = 12000;             /* the far end's tun hello must arrive within this, or the leg is dead */
const TUN_OFFER_MS = 100000;            /* from roles to the offer: the host's dials, worst honest case */
const TUN_READY_MS = 75000;             /* from the offer to both sides' streams: the guest's one dial, and the host's wait for it */
const TUN_KEEPALIVE_MS = 45000;         /* well inside a 2-minute silence deadline */
const TUN_FRAME_MAX = PIPE_CHUNK * 2 + PIPE_HDR + 64;
const TUN_SID_RE = /^[0-9a-f]{24}$/;
/* A tunnel stream handle ({ write, end, cancel }) framed for PipeChannel. */
class TunWire {
  constructor(handle) {
    this.h = handle; this.q = []; this.busy = false; this.dead = false;
    this.onFrame = null; this.onDead = null; this._buf = new Uint8Array(0);
    this._ka = setInterval(() => this.send(null), TUN_KEEPALIVE_MS);
  }
  /* frame: a pipe frame (Uint8Array), or null for a keepalive. true = queued. */
  send(frame) {
    if (this.dead) return false;
    const n = frame ? frame.byteLength : 0;
    const out = new Uint8Array(4 + n);
    new DataView(out.buffer).setUint32(0, n, true);
    if (frame) out.set(frame, 4);
    this.q.push(out); this._pump();
    return true;
  }
  _pump() {
    if (this.busy || this.dead || !this.q.length) return;
    this.busy = true;
    const b = this.q.shift();
    let p; try { p = this.h.write(b); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(() => { this.busy = false; this._pump(); }, () => this.die('write'));
  }
  /* Bytes from the far end: reassemble [4 len][frame]… and hand each frame up. */
  feed(chunk) {
    if (this.dead || !(chunk instanceof Uint8Array)) return;
    let buf = chunk;
    if (this._buf.byteLength) { buf = new Uint8Array(this._buf.byteLength + chunk.byteLength); buf.set(this._buf, 0); buf.set(chunk, this._buf.byteLength); }
    let off = 0;
    while (buf.byteLength - off >= 4) {
      const n = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true);
      if (n > TUN_FRAME_MAX) { this.die('frame'); return; }
      if (buf.byteLength - off - 4 < n) break;
      if (n > 0 && this.onFrame) { const f = buf.buffer.slice(buf.byteOffset + off + 4, buf.byteOffset + off + 4 + n); try { this.onFrame(f); } catch {} }
      off += 4 + n;
    }
    this._buf = off < buf.byteLength ? buf.slice(off) : new Uint8Array(0);
  }
  die(why) { if (this.dead) return; this.dead = true; clearInterval(this._ka); this.q = []; try { this.h.cancel(); } catch {} if (this.onDead) { try { this.onDead(why); } catch {} } }
  /* A goodbye: end the send stream cleanly (the machine ends the session), and cut both a moment later if that never lands. */
  close() { if (this.dead) return; this.dead = true; clearInterval(this._ka); this.q = []; const h = this.h; try { h.end(); } catch {} setTimeout(() => { try { h.cancel(); } catch {} }, 1000); }
}

/* ---- upload link leg tuning ---- */
const LINK_RECEIPT_MS = 10 * 60 * 1000;   /* how long a link delivery waits for the peer's receipt before falling back to a transport */
const LINK_DONE_TTL = LINK_RECEIPT_MS + RESUME_GRACE;   /* the receiver remembers a link-delivered file at least this long — the sender can re-offer it over a transport until then */

/* ===================================================================== *
 *  2. PEER — one RTCPeerConnection + data channel + transfer engine
 * ===================================================================== */

class Peer {
  constructor(app, id, name) {
    this.app = app; this.id = id; this.name = name;
    this.owner = app.selfId < id;   /* smaller id creates the channel → no glare */
    this.dev = ''; this.orphaned = false;   /* dev: the peer's stable device id (from its name frame); orphaned: roster row gone but a live transfer is still riding the P2P channel */
    this.pc = null; this.dc = null; this.connected = false; this.gen = 0;
    this.sendQueue = []; this.sending = null; this.incoming = null;
    this.readyResolvers = Object.create(null); this.receivedResolvers = Object.create(null);   /* null-proto: a control frame keyed by id '__proto__'/'constructor'/… must not resolve to an inherited Object.prototype member and get called as a function */
    this.chunkSize = PREFERRED_CHUNK; this.sendPaused = false; this._resumeResolve = null;
    this._verified = false;   /* this connection echoed a resume tk — proven to be the original transfer partner, not just a device-id claimant */
    /* fallback race state (_fallback), the relay pipe in flight, link
       deliveries awaiting the peer's receipt, how the live channel was
       reached ('' | 'pipe' | 'tunnel'), and the tunnel leg (its PipeChannel
       and the leg's state). */
    this._fb = null; this._fbTimer = null; this._pipe = null; this._r2Items = new Map(); this._via = '';
    this._tun = null; this._tunS = null; this._tunWhy = '';
    /* The multipath race: every road that came up beside this.dc (the pipe,
       the tunnel), whether the peer can be sent framed data at all (it
       answered `caps`), and the warm race — the legs raised as soon as the
       two devices are connected rather than when a file is queued. */
    this.lanes = new Set(); this.peerMP = false; this._onTurn = false; this._warm = null; this._warmTimer = null;
  }
  busy() { return !!(this.sending || this.sendQueue.length || this.incoming || this._r2Items.size || this._r2Busy || (this._r2Q && this._r2Q.length)); }

  /* A relay credential is in hand after this pc was constructed.
     setConfiguration alone does not gather relay candidates: restart ICE so
     the owner emits a fresh offer. If this side is the answerer, ask the
     owner to restart too — ownership deliberately prevents us from offering
     and without that nudge a one-sided relay connection can stay STUN-only. */
  _adoptRelay() {
    const pc = this.pc;
    if (!pc || this.connected || pc.connectionState === 'connected' || pc.signalingState === 'closed' || pc._relayCfg) return false;
    const relay = this.app._relayNow();
    if (!relay) return false;
    try {
      pc.setConfiguration({ iceServers: this.app.iceServers.concat(relay) });
      pc._relayCfg = true;
      pc.restartIce();
      if (!this.owner) this.app.signal(this.id, { kind: 'please-restart' });
      /* Relay leg clock: ICE can sit in 'connecting' forever without a
         'failed' (nothing to fail when the far end has no usable
         candidates). Past TURN_LEG_MS the leg counts as dead for the
         verdict; the pc keeps trying underneath. */
      if (this._fb && !this._fb.turnTimer) { const gen = this.gen; this._fb.turnTimer = setTimeout(() => { if (gen === this.gen && this._fb) this._fbLegDead('turn'); }, TURN_LEG_MS); }
      return true;
    } catch { return false; }
  }

  _setupPc() {
    if (this.pc) return;
    const gen = this.gen, live = () => gen === this.gen;
    const pc = new RTCPeerConnection({ iceServers: this.app.iceServers });
    pc._relayCfg = false;   /* the first attempt is STUN-only by design — _adoptRelay flips this when a fallback restarts ICE with the relay entry */
    this.pc = pc;
    /* null / empty-string candidate = end-of-candidates — always passes. */
    pc.onicecandidate = ({ candidate }) => { if (live()) this.app.signal(this.id, { kind: 'candidate', candidate }); };
    pc.onnegotiationneeded = async () => {
      if (!live() || !this.owner) return;   /* only the owner offers */
      try { await pc.setLocalDescription(); if (live()) this.app.signal(this.id, { kind: 'description', description: pc.localDescription }); }
      catch (e) { console.error('[lan] negotiation', e); }
    };
    pc.onconnectionstatechange = () => {
      if (!live()) return;
      if (pc.connectionState === 'failed') {
        /* Direct is dead (or a relay-backed retry died too): every fallback
           starts now — _fallback runs the relay leg, the pipe, the tunnel
           and the link together (sender side; no-op with nothing to send).
           A credential already in hand restarts ICE with the relay right
           here; otherwise plain restartIce keeps the direct attempt alive
           while the relay leg is in flight. */
        if (this._fb && pc._relayCfg) this._fbLegDead('turn');   /* the relay-backed attempt is the one that failed */
        this._fallback('failed');
        const restarted = this._adoptRelay();
        if (restarted && !this._fb) this._shareRelay();   /* receiver side (nothing to send): a credential WE hold is installed and offered back */
        if (!restarted) { try { pc.restartIce(); } catch {} }
        this.app.ui.peerState(this.id, (this._fb && !this._fbDead()) ? 'connecting' : 'failed');
      }
    };
    pc.ondatachannel = (ev) => { if (live()) this._bindChannel(ev.channel); };
  }

  /* Begin a connection (called when this side wants to send). Owner creates
     the channel; non-owner asks the owner to. A DEAD channel (closed/closing —
     e.g. after a drop we want to resume across) is torn down and rebuilt. */
  ensureChannel() {
    if (this.dc && this.dc.readyState !== 'closed' && this.dc.readyState !== 'closing') return;
    if (this.dc || this.pc) this.teardown();   /* settle the dead link's transfer state first (suspend/fail via _onClosed) — a bare reset would swallow its close event and strand this.sending forever */
    this._setupPc();
    if (this.owner) { this._bindChannel(this.pc.createDataChannel('files', { ordered: true })); }
    else { this.app.signal(this.id, { kind: 'please-offer' }); }
    this._armFallback();   /* a pc that never even reaches 'connecting' (no answer at all) must still fall back */
  }
  _connDead() { return (this.dc && (this.dc.readyState === 'closed' || this.dc.readyState === 'closing')) || (this.pc && (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed')); }

  onSignal(payload) {
    const k = payload && payload.kind;
    /* Fallback plumbing rides the same signalling path as the handshake. */
    if (k === 'turn') { if (this.app._relayAdoptShared(payload) && this.pc && !this.connected && !this.pc._relayCfg) this._adoptRelay(); return; }   /* the peer's credential serves THIS attempt only — never every pc on the node */
    if (k === 'ctl') { const m = payload.m || {}; if (m.t === 'awaiting') { if (this.sending && this.sending.id === m.id) this.app.ui.xferAwait(this.id, this.sending); } else if (m.t === 'trust') this.app._takeTok(this.dev, this.id, m.tok); return; }
    if (k === 'r2') { this._onR2Offer(payload); return; }
    if (k === 'r2-received' || k === 'r2-failed') { this._onR2Receipt(payload, k === 'r2-received'); return; }
    if (k === 'tun') { this._onTun(payload); return; }
    if (this._pipeActive()) return;   /* the relay pipe carries this link — handshake traffic for the dropped pc is stale */
    if (k === 'please-offer') { if (this.owner) this.ensureChannel(); return; }
    /* The answerer just gained a relay configuration. It never creates
       offers (glare ownership), so restart from the owner and let the next
       answer carry its new relay candidates. One nudge per pc is enough. */
    if (k === 'please-restart') {
      if (this.owner && this.pc && !this.pc._remoteRelayRestart) {
        this.pc._remoteRelayRestart = true;
        try { this.pc.restartIce(); } catch {}
      }
      return;
    }
    /* A fresh offer aimed at a connection we already consider dead = the other side
       rebuilt after a drop (resume redial). Tear down so the offer lands on a NEW pc
       (setRemoteDescription on a closed/failed one would just throw) AND so the dead
       link's transfers settle into suspend/fail — its own close event is now swallowed. */
    if (k === 'description' && payload.description && payload.description.type === 'offer' && this._connDead()) this.teardown();
    this._setupPc();
    const pc = this.pc;
    (async () => {
      try {
        if (k === 'description' && payload.description) {
          await pc.setRemoteDescription(payload.description);
          if (payload.description.type === 'offer') { await pc.setLocalDescription(); this.app.signal(this.id, { kind: 'description', description: pc.localDescription }); }
        } else if (k === 'candidate') {
          try { await pc.addIceCandidate(payload.candidate || undefined); } catch {}
        }
      } catch (e) { console.error('[lan] signal', e); }
    })();
  }

  _bindChannel(dc) {
    this.dc = dc; dc.binaryType = 'arraybuffer';
    /* live = this generation AND still the bound channel: a channel the
       fallback race superseded (a WebRTC channel opening after the pipe
       was adopted, or vice versa) must neither open onto the peer (it
       closes itself) nor tear the peer down when it closes. */
    const gen = this.gen, live = () => gen === this.gen && this.dc === dc;
    try { dc.bufferedAmountLowThreshold = LOW_WATER; } catch {}
    dc.onopen = () => {
      if (!live()) { try { dc.close(); } catch {} return; }
      this.connected = true; this._fbSettle(); this.app.ui.peerState(this.id, 'connected');
      /* clamp chunks to what the remote's SCTP stack accepts: prefer PREFERRED_CHUNK, floor at MIN_CHUNK, but the negotiated max-message-size is the hard ceiling — never floor above it (a peer may advertise < MIN_CHUNK, and a 16KiB send would then throw) */
      const sctp = this.pc && this.pc.sctp && this.pc.sctp.maxMessageSize; if (sctp) this.chunkSize = Math.min(sctp, Math.max(MIN_CHUNK, Math.min(PREFERRED_CHUNK, sctp)));
      if (dc instanceof PipeChannel) this.chunkSize = Math.min(this.chunkSize, PIPE_CHUNK);
      this._safe({ t: 'caps', mp: 1 }); this._raceWarm(); this._roadsChanged(); this._turnProbe();
      this.app._resumeInto(this); this._pump();
    };
    dc.onclose = () => { if (!live()) return; this._resetConn(); this._onClosed(); this.app.ui.peerState(this.id, 'failed'); };   /* reset FIRST (null dc/pc, bump gen) so a resume redial can rebuild */
    dc.onmessage = (ev) => { if (live()) this._onMessage(ev.data); };
  }

  /* ---- the multipath race ----
     this.dc stays THE channel: every control frame (meta / ready / done /
     received / pause / cancel / trust) travels it and it alone, so the
     protocol is unchanged and a road that dies mid-file still suspends and
     resumes the way one always did. What changes is the data: each extra
     road that comes up joins this.lanes, and a raced file is streamed down
     every one of them at once from the same starting offset. Each frame
     carries its offset, the receiver writes only what is past its mark, and
     the first road to carry the last byte ends the transfer — the others
     are cut where they stand.

     Nothing is raced until the far end answers `caps`: an older build reads
     a chunk as "the next bytes", and an offset header would land in the
     file. It also never sees an extra road, because every leg below refuses
     to be adopted while a channel is live unless peerMP says otherwise. */
  _onCaps(m) {
    const was = this.peerMP;
    /* mp is a FORMAT version, not a flag: a peer that speaks a different
       one is not raced at all, because a frame layout only one end knows
       would be written into the file as data. Bump it here and in the
       frame if the layout ever changes. */
    this.peerMP = !!(m && m.mp === 1);
    this._roadsChanged();
    if (this.peerMP && !was) this._raceWarm();   /* the answer to our own caps: the roads can go up now */
  }
  _mpOn() { return !!this.peerMP; }
  /* Which road the WebRTC channel actually took, for the roads report: a
     credential in the config only says a relay was OFFERED. One stats read
     when the channel opens settles it. */
  _turnProbe() {
    const pc = this.pc, gen = this.gen;
    if (!pc) { this._onTurn = false; return; }
    usingRelay(pc).then((r) => { if (gen !== this.gen) return; this._onTurn = !!r; this._roadsChanged(); }, () => {});
  }
  /* Every channel a file may ride right now, this.dc first. */
  _laneList() {
    const out = [];
    if (this.dc && this.dc.readyState === 'open') out.push(this.dc);
    for (const ch of this.lanes) if (ch.readyState === 'open') out.push(ch);
    return out;
  }
  /* An extra road is up. It carries data only — its control frames are
     ignored (the far end sends them on this.dc), and its close takes it out
     of the race without touching the peer. */
  _addLane(ch) {
    if (!ch || ch === this.dc || this.lanes.has(ch)) return false;
    this.lanes.add(ch);
    ch.binaryType = 'arraybuffer';
    try { ch.bufferedAmountLowThreshold = LOW_WATER; } catch {}
    const gen = this.gen;
    ch.onmessage = (ev) => { if (gen === this.gen && this.lanes.has(ch) && !(typeof ev.data === 'string')) this._onChunk(ev.data); };
    ch.onclose = () => { if (gen === this.gen) this._dropLane(ch); };
    this._roadsChanged();
    /* A file already in flight: this road joins it from the same offset the
       others started at — a lane that began mid-file could leave a hole no
       later frame ever fills if the road ahead of it died in between. */
    const it = this.sending;
    if (it && it._mp && !it._won && it.status === 'sending' && Number.isFinite(it._mpStart)) this._laneRun(ch, it);
    return true;
  }
  /* One road's run at one file, bookkept so the send knows when the race is
     decided: the first road to finish sets _ok, and the send is only judged
     failed when the LAST road standing has died — a road that joined
     mid-file counts too, which is why the count lives on the item and not
     in the array the send started with. */
  _laneRun(ch, item) {
    item._live = (item._live || 0) + 1;
    return this._stream(ch, item, item._mpStart, true).then(() => { item._ok = true; }, () => {})
      .then(() => { item._live--; if (item._settle && item._live <= 0) item._settle(); });   /* settle means NO road is left running — a road that merely finished handing frames to its channel has proved nothing yet */
  }
  _dropLane(ch) {
    if (!this.lanes.delete(ch)) return;
    ch.onmessage = ch.onclose = null;
    try { ch.close(); } catch {}
    if (this._pipe === ch) this._pipe = null;
    if (this._tun === ch) { this._tun = null; this._tunTeardown(); }
    this._roadsChanged();
  }
  _dropLanes() { for (const ch of [...this.lanes]) this._dropLane(ch); }   /* through _dropLane, so _pipe/_tun are cleared with them: a leg whose reference survives its channel can never be raised again (_fbPipe/_fbTun refuse while one is held) */
  _roadsChanged() { try { this.app.ui.peerRoads(this.id, this.roads()); } catch {} }
  /* What carries this pair: which roads, where the tunnel leg stands, and
     whether the pair races at all. */
  roads() {
    const out = [];
    if (this.dc && this.dc.readyState === 'open') out.push(this.dc instanceof PipeChannel ? (this.dc.via === 'tunnel' ? 'tunnel' : 'pipe') : (this._onTurn ? 'turn' : 'rtc'));
    for (const ch of this.lanes) if (ch.readyState === 'open') out.push(ch.via === 'tunnel' ? 'tunnel' : 'pipe');
    return { list: out, tun: this.tunState(), mp: this.peerMP };
  }
  /* The tunnel leg in one word: 'live' | 'dialling' | 'idle' | 'none' (no
     machine this node may dial, and no provider) | 'off' (the peer or
     this node cannot race at all) | 'fail'. */
  tunState() {
    if (this._tun && this.lanes.has(this._tun) && this._tun.readyState === 'open') return 'live';
    if (this.dc && this.dc.via === 'tunnel' && this.dc.readyState === 'open') return 'live';
    if (this._tunS) return this._tunS.role === null && !this.app._tunCanHost() && !this._tunS.peerHost ? 'none' : 'dialling';
    if (!this.peerMP) return 'off';
    if (this._tunWhy) return this._tunWhy === 'no-machine' ? 'none' : 'fail';
    return this.app._tunCanHost() ? 'idle' : 'none';
  }
  /* The warm race: the roads go up as soon as the two devices are connected,
     not when a file is queued. Only the two roads that can live BESIDE a
     channel run warm — the relay leg is the same pc restarting its ICE, and
     the link leg uploads a file that does not exist yet. */
  _raceWarm() {
    if (this._warm || !this.peerMP || !this.connected) return;   /* a fallback race may still be flagged (it ended the moment a channel opened) — that is no reason not to raise the other roads */
    this._warm = { pipe: 'trying', tun: 'trying' };
    this._fbPipe();
    this._fbTun();
  }
  /* The race state a leg belongs to: the fallback race when one is running,
     otherwise the warm race. */
  _race() { return this._fb || this._warm; }

  _resetConn() { this.gen++; this._dropLanes(); this.peerMP = false; this._onTurn = false; this._warm = null; if (this._warmTimer) { clearTimeout(this._warmTimer); this._warmTimer = null; } try { this.dc && this.dc.close(); } catch {} try { this.pc && this.pc.close(); } catch {} this.dc = this.pc = null; this.connected = false; this._verified = false; this._fbReset(); }
  teardown() { this._r2Abort(); this._r2AbortRecv(); this._resetConn(); this._onClosed(); }   /* the peer is gone for good: no upload may complete into a link offer nobody can receive, and no link download may finish into a receipt nobody can take */

  /* ---- send ---- */
  enqueue(files) {
    /* tk: a per-transfer secret that only ever travels the original DTLS-private
       DataChannel. The device id is public (announced in the name frame), so
       resume must NOT trust it alone — a room member could spoof a victim's
       device id and be handed the rest of a suspended file. Both resume
       directions prove knowledge of tk. */
    for (const file of files) { const item = { id: randHex(5), tk: randHex(8), file, sent: 0, status: 'queued', samples: [] }; this.sendQueue.push(item); this.app.ui.addXfer(this.id, this.name, item, 'send'); }
    this.ensureChannel();
    if (this._fb && !this.connected) this._fbR2();   /* files queued while the race is on join the link leg too */
    this._pump();
  }
  async _pump() {
    if (this.sending || !this.sendQueue.length) return;
    if (!this.dc || this.dc.readyState !== 'open') return;
    const dc = this.dc, item = this.sendQueue.shift();
    if (item._r2 && !item._r2.done) { try { item._r2.ctrl.abort(); } catch {} item._r2 = null; }   /* a transport got here first — the parallel link upload for this file is moot */
    this.sending = item; item.status = 'sending';
    try {
      /* A queued-but-never-offered file resuming alongside verified work must wait for
         this connection to prove itself (an offered sibling's tk echo) — never leak even
         its meta to a device-id spoofer. Checked before anything is sent. */
      if (item._needVerify && !this._verified) { item.status = 'error'; this.app.ui.xferError(this.id, item, 'send'); return; }
      const mp = this._mpOn();
      if (mp && this.lanes.size) this.app.ui.xferVia(this.id, item, 'send', 'race');
      else if (dc instanceof PipeChannel) this.app.ui.xferVia(this.id, item, 'send', dc.via);
      else if (this._onTurn) this.app.ui.xferVia(this.id, item, 'send', 'turn');
      /* r:1 advertises resume; a re-offer after a drop reuses the SAME item id. tk (the
         per-transfer secret) rides ONLY the first offer — the original, DTLS-private
         channel. A re-offer never repeats it: the new connection merely claims the same
         device id, and handing it the secret would let a spoofer "prove" itself. */
      /* First-contact trust rides ONLY a fresh offer. A resumed offer's peer
         hasn't echoed tk yet (a device-id spoofer could be claiming a suspended
         transfer), so granting our token or echoing theirs here would leak it
         to the unverified side — deferred until the tk check below. */
      if (!item._resumed) this.app._grantTrust(this);
      /* mp:1 says every data frame for THIS file carries its offset, so the
         receiver can take it from any road. Sent only to a peer that
         answered `caps`; an older one gets exactly what it always got. */
      item._tag = mpTagOf(item.id);
      dc.send(JSON.stringify({ t: 'meta', id: item.id, name: item.file.name, size: item.file.size, mime: item.file.type || 'application/octet-stream', r: 1, mp: mp ? 1 : undefined, tk: item._everOffered ? undefined : item.tk, tt: item._resumed ? undefined : this.app._tokFor(this.dev, this.id) }));
      item._everOffered = true;
      const rm = await new Promise((res) => { this.readyResolvers[item.id] = res; });
      if (item._resumed && item.status === 'sending' && !(rm && rm.tk === item.tk)) {
        /* Resumed send, but the answering end can't prove it saw the original offer
           (no/wrong tk): a device-id spoofer, or a receiver whose state is gone. Don't
           stream a byte to it. (status must still be 'sending' — a re-drop flushes the
           resolver with rm=undefined AFTER suspending the item; that's not a failure.) */
        item.status = 'error'; this.app.ui.xferError(this.id, item, 'send'); this._safe({ t: 'cancel', id: item.id });
      } else if (item.status !== 'declined' && item.status !== 'canceled' && item.status !== 'suspended') {
        if (item._resumed && rm && rm.tk === item.tk) { this._verified = true; this.app._grantTrust(this); }   /* this connection echoed a secret only the original receiver ever saw — NOW it's safe to (re)grant first-contact trust */
        this.sendPaused = false;
        const offN = rm && Number(rm.off);
        const startOff = (item._resumed && Number.isFinite(offN) && offN > 0) ? Math.min(Math.floor(offN), item.file.size) : 0;   /* a non-zero off is only meaningful (and only trusted) on a verified resume */
        item._mp = mp; item._mpStart = startOff; item._won = false;
        /* Registered BEFORE a byte moves: with several roads running, the
           receipt can arrive while this.dc is still streaming its own copy. */
        const ack = new Promise((res) => { this.receivedResolvers[item.id] = res; });
        if (mp) {
          /* Every road carries the whole file from the same offset, and the
             first to land the last byte wins: the receiver's mark reaches
             the end, it acks, and the roads still mid-file are cut where
             they stand (item._won). */
          item._live = 0; item._ok = false;
          let acked = false; ack.then(() => { acked = true; });
          const settled = new Promise((res) => { item._settle = res; });
          const lanes = this._laneList();
          for (const ch of lanes) this._laneRun(ch, item);
          if (!lanes.length) throw new Error('aborted');   /* no road is open at all */
          /* NO `done` frame here. It would ride this.dc while the road that
             actually carried the file is another channel entirely, so it
             could overtake that road's last frames and be read as "the file
             is complete" against a mark that has not reached the end —
             the receive would fail as truncated with the bytes still in
             flight. A raced receive finishes on its own mark instead, and
             its receipt is what ends this send. The one file with no mark
             to reach is the empty one, which has no frames to overtake. */
          if (!item.file.size && item.status === 'sending') { try { dc.send(JSON.stringify({ t: 'done', id: item.id })); } catch {} }
          await Promise.race([settled, ack]);
          item._won = true; item._settle = null;
          if (!acked && !item._ok) throw new Error('aborted');   /* every road died mid-file — the close handler parks it for resume */
          await ack;
        } else {
          await this._stream(dc, item, startOff);
          dc.send(JSON.stringify({ t: 'done', id: item.id }));
          await ack;
        }
        if (item.status === 'sending') { item.status = 'done'; this.app.ui.xferDone(this.id, item, 'send'); }
      }
    } catch (e) {
      /* The wire died mid-stream: _stream's throw beats the dc close EVENT, so deciding
         error-vs-resume here would always say error. Park the item back at the queue
         head instead — the close handler (which always follows: close event or teardown)
         suspends it for resume, or the error sweep there fails it. */
      if (item.status === 'sending' && (!this.dc || this.dc.readyState !== 'open')) { item.status = 'queued'; this.sendQueue.unshift(item); }
      else if (item.status !== 'canceled' && item.status !== 'suspended') { item.status = 'error'; this.app.ui.xferError(this.id, item, 'send'); }
    }
    finally { item._won = true; item._settle = null; if (this.receivedResolvers[item.id]) delete this.receivedResolvers[item.id]; this.sending = null; this.app._reap(this); this._pump(); }   /* _won stops every lane still streaming this item, however this send ended */
  }
  /* One road's copy of one file. With mp on, several of these run at once
     over different channels and each frame says where it belongs; the
     progress callback follows whichever road is furthest along. */
  async _stream(dc, item, startOff, mp) {
    const file = item.file, size = file.size; let off = startOff || 0;
    if (off) { item.sent = Math.max(item.sent || 0, off); this._sample(item, off); }
    /* The payload this road takes, header included: never raise it to a
       floor the channel itself will not accept — a peer whose SCTP limit is
       below MIN_CHUNK would have every frame refused. */
    const room = Math.max(1, (dc instanceof PipeChannel ? Math.min(this.chunkSize, PIPE_CHUNK) : this.chunkSize) - (mp ? MP_HDR : 0));
    while (off < size) {
      if (item._won) throw new Error('won');   /* another road already carried the last byte — this one did not finish, and must not be counted as if it had */
      if (item.status === 'canceled' || item.status === 'suspended' || dc.readyState !== 'open') throw new Error('aborted');
      if (dc.bufferedAmount > HIGH_WATER) { await this._wait(dc, 'bufferedamountlow', 1000); continue; }
      if (this.sendPaused) { await this._waitResume(1000); continue; }
      const end = Math.min(off + room, size);
      const raw = await file.slice(off, end).arrayBuffer();
      if (item._won) throw new Error('won');
      const buf = mp ? mpFrame(off, raw, item._tag) : raw;
      try { dc.send(buf); } catch { await this._wait(dc, 'bufferedamountlow', 200); if (dc.readyState !== 'open') throw new Error('closed'); dc.send(buf); }
      off = end;
      if (off > (item.sent || 0)) { item.sent = off; this._sample(item, off); const { rate, eta } = this._stats(item, size); this.app.ui.xferProgress(this.id, item, off / size, rate, eta, 'send'); }   /* the progress follows the road in front */
    }
  }
  _wait(dc, ev, ms) { return new Promise((res) => { let done = false; const f = () => { if (done) return; done = true; clearTimeout(t); dc.removeEventListener(ev, f); dc.removeEventListener('close', f); res(); }; const t = setTimeout(f, ms); dc.addEventListener(ev, f); dc.addEventListener('close', f); }); }
  _waitResume(ms) { return new Promise((res) => { const f = () => { clearTimeout(t); if (this._resumeResolve === f) this._resumeResolve = null; res(); }; const t = setTimeout(f, ms); this._resumeResolve = f; }); }

  /* ---- receive (sink chosen by the app's openSink hook) ---- */
  _onMessage(data) { if (typeof data === 'string') this._onControl(data); else this._onChunk(data); }
  _onControl(text) {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (m.t === 'meta') this._onMeta(m);
    else if (m.t === 'ready') { const r = this.readyResolvers[m.id]; if (typeof r === 'function') { delete this.readyResolvers[m.id]; r(m); } }
    else if (m.t === 'done') this._finish(m.id);
    else if (m.t === 'received') { const r = this.receivedResolvers[m.id]; if (typeof r === 'function') { delete this.receivedResolvers[m.id]; r(); } }
    else if (m.t === 'awaiting') { if (this.sending && this.sending.id === m.id) this.app.ui.xferAwait(this.id, this.sending); }   /* receiver is showing its first-contact accept prompt */
    else if (m.t === 'caps') { this._onCaps(m); }   /* the far end can read offset-framed data: the multipath race is on for this pair */
    else if (m.t === 'trust') { this.app._takeTok(this.dev, this.id, m.tok); }   /* this device granted us first-contact trust — echo the token on future offers (_takeTok validates the shape) */
    else if (m.t === 'pause') { if (this.sending && this.sending.id === m.id) this.sendPaused = true; }
    else if (m.t === 'resume') { if (this.sending && this.sending.id === m.id) { this.sendPaused = false; if (this._resumeResolve) this._resumeResolve(); } }
    else if (m.t === 'cancel') this._remoteCancel(m.id);
  }
  _onMeta(m) {
    /* The same file is still coming down as a link (its receipt never
       reached the sender, so it re-offers over a channel): the channel
       wins — drop the link download, receive once. */
    const lr = this._r2Live && this._r2Live.get(m.id);
    if (lr && !lr._ended) { lr._ended = true; this._r2Live.delete(m.id); releaseSink(lr); this.app.ui.xferDrop(this.id, lr, 'recv'); }
    if (this.incoming) this._abort(this.incoming);   /* a new offer supersedes an unfinished one (frees a stale accept prompt / waiting sender) */
    const claimed = this.app._claimRecv(this.dev, m);
    if (claimed) { this.app._grantTrust(this); claimed.rec._mp = !!m.mp; claimed.rec._tag = mpTagOf(m.id); claimed.rec.written = claimed.rec.received; this._resume(claimed); return; }   /* the sender re-offered a receive we suspended on a drop — pick up at the settled offset, same sink; a resumable receive was accepted once already. The re-offer decides afresh whether this leg is raced: the roads it has now are not the ones it had then */
    const jd = this.app._justDone(this.dev, m.id);
    if (jd) { this.app._grantTrust(this); this._safe({ t: 'ready', id: m.id, off: Number(m.size) || 0, tk: jd.tk }); return; }   /* we finished this one but our receipt was lost in the drop — don't receive it twice */
    const size = Number(m.size);
    /* written: how far the file is complete from byte 0, across every road.
       With mp on it is the mark that decides what a frame contributes and
       when the file is whole; without it, it simply tracks received. */
    const rec = { id: m.id, name: m.name || 'file', size: Number.isFinite(size) && size >= 0 ? size : 0, mime: m.mime || 'application/octet-stream', tk: (typeof m.tk === 'string' && m.tk.length >= 8 && m.tk.length <= 32) ? m.tk : '', _tt: /^[0-9a-f]{24}$/.test(m.tt || '') ? m.tt : '', _mp: !!m.mp, _tag: mpTagOf(m.id), written: 0, received: 0, inFlight: 0, recvPaused: false, samples: [], chain: Promise.resolve(), sink: null, _cancelPrompt: null };
    this.incoming = rec;
    this.app.ui.addXfer(this.id, this.name, rec, 'recv');
    if (rec._mp && this.lanes.size) this.app.ui.xferVia(this.id, rec, 'recv', 'race');
    else if (this.dc instanceof PipeChannel) this.app.ui.xferVia(this.id, rec, 'recv', this.dc.via);
    else if (this._onTurn) this.app.ui.xferVia(this.id, rec, 'recv', 'turn');
    this._accept(rec);   /* opens a sink (may await a user gesture), then sends `ready` */
  }
  /* Revive a suspended receive on this (possibly brand-new) connection: wait for every
     already-received byte to settle to the sink, then tell the sender exactly where to
     resume. The sink (open FSA writable / mem parts) carries over. */
  async _resume(claim) {
    const rec = claim.rec, gen = this.gen;
    this.incoming = rec; rec.recvPaused = false; rec.samples = [];   /* inFlight is NOT reset: the old chain's settled writes each decrement it exactly once — it reaches 0 naturally by the await below */
    this.app.ui.rekeyXfer(claim.fromId, this.id, rec, 'recv');
    try { await rec.chain; } catch {}                /* drain queued writes so rec.received === bytes settled */
    if (gen !== this.gen || this.incoming !== rec) return;   /* dropped again / superseded while settling */
    if (rec._ended || !rec.sink) {                   /* a queued write failed while suspended — the sink is gone; cancel cleanly */
      if (this.incoming === rec) this.incoming = null;
      if (!rec._ended) { rec._ended = true; releaseSink(rec); this.app.ui.xferError(this.id, rec, 'recv'); }
      this._safe({ t: 'cancel', id: rec.id });
      return;
    }
    rec.written = rec.received;
    this._safe({ t: 'ready', id: rec.id, off: rec.received, tk: rec.tk });   /* tk proves WE saw the original offer — the sender streams a resume to no one else */
  }
  /* Pick where the bytes land, then release the sender. The sender streams only
     after `ready`, so awaiting an accept prompt / a save picker here is safe. */
  async _accept(rec) {
    try {
      /* First-contact confirmation: the first file from a device you've never
         exchanged files with must be explicitly accepted (ui.promptAccept —
         the default accepts). Skipping the gate requires the offer to echo
         our trust token (rec._tt) — the public device id alone is spoofable. */
      const firstContact = !this.app.isTrusted(this.dev, this.id, rec._tt);
      if (firstContact) {
        this._ctl({ t: 'awaiting', id: rec.id });   /* older peers ignore unknown control frames */
        await this.app.ui.promptAccept(this.id, rec);
        if (this.incoming !== rec) return;   /* superseded while the prompt was up */
        this.app._grantTrust(this);
      }
      rec.sink = await this.app.openSink(this, rec);   /* may await a user gesture (e.g. a save picker) */
      if (!rec.sink) throw new Error('too-large');     /* the sink provider refused (e.g. over the in-memory cap) */
      if (this.incoming !== rec) { try { await rec.sink.abort(); } catch {} return; }   /* superseded/canceled while awaiting a gesture */
      this._safe({ t: 'ready', id: rec.id });   /* a no-op with no channel (a link-delivered file needs none) */
    } catch (e) {
      if (rec._ended) return;       /* already torn down by _abort/_remoteCancel (e.g. superseded while the prompt was open) — don't double-cancel */
      rec._ended = true;
      if (this.incoming === rec) this.incoming = null;
      rec.status = (e && e.message === 'declined') ? 'declined' : 'canceled';
      this.app.ui.xferError(this.id, rec, 'recv');
      this._safe({ t: 'cancel', id: rec.id });
    }
  }
  _onChunk(buf) {
    const rec = this.incoming; if (!rec || !rec.sink || rec._ended) return;
    /* A raced frame says where it belongs. Every road sends the whole file
       from the same offset, so what arrives is either past the mark (the
       road in front — write it) or behind it (a slower road repeating what
       is already on disk — drop it). A frame that straddles the mark is
       trimmed. Nothing is ever written twice and nothing is written out of
       order, so one sink serves every road. */
    if (rec._mp) {
      const take = mpTake(rec.written, rec.size, buf, rec._tag);
      if (take === 'bad') { this._abort(rec); return; }   /* lying sender guard */
      if (!take) return;
      buf = take.data; rec.written = take.mark; rec.received = take.mark;
    } else {
      rec.received += buf.byteLength;
      if (rec.received > rec.size) { this._abort(rec); return; }   /* lying sender guard */
      rec.written = rec.received;
    }
    rec.inFlight += buf.byteLength;
    rec.chain = rec.chain.then(() => rec.sink.write(buf)).then(() => {
      rec.inFlight -= buf.byteLength;
      if (rec.recvPaused && rec.inFlight <= RECV_LOW) { rec.recvPaused = false; this._safe({ t: 'resume', id: rec.id }); }
    }, () => { this._abort(rec); });
    if (!rec.recvPaused && rec.inFlight >= RECV_HIGH) { rec.recvPaused = true; this._safe({ t: 'pause', id: rec.id }); }   /* disk slower than the wire — hold the sender */
    this._sample(rec, rec.received);
    const { rate, eta } = this._stats(rec, rec.size);
    this.app.ui.xferProgress(this.id, rec, rec.size ? rec.received / rec.size : 0, rate, eta, 'recv');
    /* Raced: the file is whole the instant the mark reaches the end — the
       `done` frame from this.dc's own copy may still be minutes away on a
       slower road, and waiting for it would throw away the race. */
    if (rec._mp && rec.size && rec.written >= rec.size) this._finish(rec.id);
  }
  _teardownSink(rec) { releaseSink(rec); }
  async _finish(id) {
    const rec = this.incoming;
    if (!rec || rec.id !== id) { if (this.app._justDone(this.dev, id)) this._safe({ t: 'received', id }); return; }   /* re-offered file we'd already completed (receipt lost in a drop) → re-ack so the sender closes out */
    this.incoming = null;
    try {
      await rec.chain;              /* drain queued writes */
      if (rec._ended) return;       /* a queued write already failed and aborted */
      if (rec.size && rec.received !== rec.size) throw new Error('truncated');   /* `done` arrived before every byte — don't finalize a short file as received */
      await rec.sink.close();       /* FSA: the file lands at its destination; Mem: the Blob is delivered */
      rec._ended = true;
      this.app._markDone(this.dev, id, rec.tk);
      this.app.ui.xferDone(this.id, rec, 'recv'); this._safe({ t: 'received', id });
    } catch (e) { if (!rec._ended) { rec._ended = true; this._teardownSink(rec); this.app.ui.xferError(this.id, rec, 'recv'); this._safe({ t: 'cancel', id }); } }
    finally { this.app._reap(this); this._r2Drain(); }
  }
  /* Tear down an in-progress receive exactly once (the write chain can reject for
     several queued chunks; _ended makes finish/abort mutually exclusive). */
  _abort(rec) {
    if (!rec || rec._ended) return; rec._ended = true;
    if (rec._cancelPrompt) rec._cancelPrompt();
    this._teardownSink(rec);
    this.app.ui.xferError(this.id, rec, 'recv'); this._safe({ t: 'cancel', id: rec.id });
    if (this.incoming === rec) this.incoming = null;
    this.app._reap(this);
    this._r2Drain();
  }
  _remoteCancel(id) {
    if (this.incoming && this.incoming.id === id) { const rec = this.incoming; rec._ended = true; if (rec._cancelPrompt) rec._cancelPrompt(); this._teardownSink(rec); this.app.ui.xferError(this.id, rec, 'recv'); this.incoming = null; }
    if (this.sending && this.sending.id === id) { this.sending.status = 'canceled'; this.sendPaused = false; if (this._resumeResolve) this._resumeResolve(); this.app.ui.xferError(this.id, this.sending, 'send'); }
    const rr = this.readyResolvers[id]; if (rr) { delete this.readyResolvers[id]; rr(); }
    const cr = this.receivedResolvers[id]; if (cr) { delete this.receivedResolvers[id]; cr(); }
    this.app._reap(this);
    this._r2Drain();
  }
  _onClosed() {
    this.sendPaused = false;
    this.app._suspendFrom(this);   /* park resumable transfers (send queue + mid-file receive) keyed by the peer's device id before the error sweep below can kill them */
    if (this.sending && this.sending.status === 'sending') { this.sending.status = 'error'; this.app.ui.xferError(this.id, this.sending, 'send'); }
    if (this._resumeResolve) this._resumeResolve();
    for (const k of Object.keys(this.readyResolvers)) { this.readyResolvers[k](); delete this.readyResolvers[k]; }
    for (const k of Object.keys(this.receivedResolvers)) { this.receivedResolvers[k](); delete this.receivedResolvers[k]; }
    if (this.incoming) this._abort(this.incoming);
    this.app._reap(this);
    this._r2Drain();
  }
  _safe(o) { if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(JSON.stringify(o)); } catch {} } }
  /* A control note that must reach the peer even when no channel is open (the
     link-delivered file has none): the channel when there is one, else the
     signalling path as {kind:'ctl', m} — only awaiting/trust travel this way. */
  _ctl(o) { if (this.dc && this.dc.readyState === 'open') this._safe(o); else this.app.signal(this.id, { kind: 'ctl', m: o }); }
  _sample(item, bytes) { const now = performance.now(); item.samples.push([now, bytes]); while (item.samples.length > 2 && now - item.samples[0][0] > 2000) item.samples.shift(); }
  _stats(item, total) { const s = item.samples; if (s.length < 2) return { rate: 0, eta: NaN }; const dt = (s[s.length - 1][0] - s[0][0]) / 1000; const db = s[s.length - 1][1] - s[0][1]; const rate = dt > 0 ? db / dt : 0; const done = item.sent != null ? item.sent : (item.received || 0); return { rate, eta: rate > 0 ? Math.max(0, total - done) / rate : NaN }; }

  /* ---- no direct route: every fallback at once ----
     Direct (STUN-only ICE) is judged dead on connectionState 'failed', or
     FALLBACK_MS after the channel was asked for with no channel at all
     (_armFallback). From that instant the legs run in parallel and the
     FIRST to come up carries the file:
       turn — a relay-backed ICE restart: fetch / reuse the relay entry
              (`relayIceServers`), hand it to the peer over signalling,
              restart ICE with it (both ends gather relay candidates; ICE's
              own race picks a pair). Wins when the WebRTC data channel
              opens.
       pipe — the discovery session's byte pipe (PipeChannel). Wins when
              the far end acks the knock and we commit.
       tun  — the tunnel provider's machine couples the two streams
              (PipeChannel over a TunWire).
       r2   — per FILE within the link store's cap: AES-GCM-encrypt, put it
              in the store, hand URL + key to the peer, which gets and
              decrypts. An upload that finishes before a transport started
              that file takes it out of the queue (the peer's receipt closes
              it); a transport that picks the file first aborts its upload.
     Only the side with something to send drives the race; the receiver's
     pc mirrors the states, adopts whatever credential is shared, answers
     the pipe knock, the tunnel hello and the link offer. The verdict turns
     terminal (ui.peerState 'failed') only once every leg is dead. */
  _wantsSend() { return !!(this.sendQueue.length || this.sending || (this.dev && this.app._susp.has(this.dev))); }
  _armFallback() {
    if (this._fbTimer || this._fb || this.connected) return;
    const gen = this.gen;
    this._fbTimer = setTimeout(() => {
      this._fbTimer = null;
      if (gen !== this.gen || this.connected) return;
      if (this._wantsSend()) { this._fallback('slow'); return; }
      /* Receiver side (nothing to send): the sender drives the fallbacks and
         hands over its credential; a credential WE already hold is installed
         (and offered back) right away. */
      if (this._adoptRelay()) this._shareRelay();
    }, FALLBACK_MS);
  }
  _fallback(reason) {
    if (this._fb || this.connected || !this._wantsSend()) return;
    if (this._fbTimer) { clearTimeout(this._fbTimer); this._fbTimer = null; }
    this._fb = { at: Date.now(), reason, turn: 'trying', pipe: 'trying', tun: 'trying', turnTimer: null };
    this.app.ui.peerState(this.id, 'connecting');
    this._fbTurn();
    this._fbPipe();
    this._fbTun();
    this._fbR2();
    this._fbCheckDead();
  }
  _fbLegDead(leg) { const r = this._race(); if (!r || r[leg] === 'dead') return; r[leg] = 'dead'; if (r === this._fb) this._fbCheckDead(); }   /* a warm leg that dies costs nothing: the pair is already connected, so there is no verdict to reach */
  _fbDead() { const f = this._fb; return !!f && f.turn === 'dead' && f.pipe === 'dead' && f.tun === 'dead' && !this.sendQueue.some((it) => it._r2 && !it._r2.done); }
  /* Every leg dead with files still waiting → the honest terminal verdict. */
  _fbCheckDead() {
    if (!this._fbDead() || this.connected) return;
    if (!this._wantsSend()) return;   /* the link leg delivered everything — nothing left to route */
    this.app.ui.peerState(this.id, 'failed');
  }
  /* A channel is open: the pending pipe knock (if it isn't the winner) is
     dropped. Link uploads stay per file — _pump moots them as it goes. */
  _fbSettle() {
    if (this._fbTimer) { clearTimeout(this._fbTimer); this._fbTimer = null; }
    if (this._fb && this._fb.turnTimer) { clearTimeout(this._fb.turnTimer); this._fb.turnTimer = null; }
    /* A road that came up is KEPT: it joins the race as a lane instead of
       being torn down for losing the sprint to open. Whether it will
       actually carry bytes is decided by `caps` — a peer that never answers
       cannot read a raced frame, so its lanes are let go once the answer is
       plainly not coming. */
    const keep = [this._pipe, this._tun].filter((ch) => ch && ch !== this.dc);
    for (const ch of keep) { if (ch.readyState === 'open') this._addLane(ch); }
    if (!keep.length) { if (!(this.dc && this.dc.via === 'tunnel')) this._tunTeardown(); return; }
    if (!this.peerMP && !this._warmTimer) this._warmTimer = setTimeout(() => { this._warmTimer = null; if (this.peerMP) return; this._dropLanes(); if (!(this.dc && this.dc.via === 'tunnel')) this._tunTeardown(); }, CAPS_WAIT_MS);
  }
  /* Run the race again on the same pc (a file came back from the link leg): every leg gets a fresh go. */
  _fbRestart() {
    const p = this._pipe; this._pipe = null;
    if (p && p !== this.dc) { try { p.close(); } catch {} }
    this._tunTeardown();
    if (this._fb && this._fb.turnTimer) clearTimeout(this._fb.turnTimer);
    this._fb = null;
    if (this.pc) { try { this.pc.restartIce(); } catch {} }
    this._fallback('retry');
  }
  _fbReset() {
    if (this._fbTimer) { clearTimeout(this._fbTimer); this._fbTimer = null; }
    if (this._fb && this._fb.turnTimer) clearTimeout(this._fb.turnTimer);
    const p = this._pipe; this._pipe = null;
    if (p) { try { p.close(); } catch {} }
    this._tunTeardown();
    this._fb = null; this._via = '';
  }
  /* Relay (TURN) leg. */
  _fbTurn() {
    if (!this._fb) return;
    const gen = this.gen;
    this.app._relayFetch().then((ok) => {
      if (gen !== this.gen || !this._fb) return;
      if (!ok && !this.app._relaySharedFresh()) { this._fbLegDead('turn'); return; }   /* no credential of our own — but one the peer shared still counts */
      if (ok) this._shareRelay();
      if (this.pc && !this.connected && !this.pc._relayCfg) this._adoptRelay();
      else if (this.pc && this.pc._relayCfg && !this._fb.turnTimer) { this._fb.turnTimer = setTimeout(() => { if (gen === this.gen && this._fb) this._fbLegDead('turn'); }, TURN_LEG_MS); }   /* adopted before the race began (a credential arrived early) → still put the leg on the clock */
    });
  }
  _shareRelay() { const own = this.app._relayOwnFresh(); if (own) this.app.signal(this.id, { kind: 'turn', iceServers: own.servers, expiresAt: own.expiresAt }); }
  /* Pipe leg (initiator side). */
  _fbPipe() {
    if (!this._race() || this._pipe) return;
    const sess = this.app._sessionOf(this.id);
    if (!PipeChannel.supported() || !(sess.disc && typeof sess.disc.pipe === 'function' && sess.selfId)) { this._fbLegDead('pipe'); return; }
    const pipe = this._pipe = new PipeChannel(this.app, this.id, true);
    pipe.hook = () => this._pipeWon(pipe);
    pipe.onfail = () => { if (this._pipe === pipe) this._pipe = null; this._fbLegDead('pipe'); };
    pipe.open();
  }
  /* The far end acked our knock. First open channel wins: a WebRTC channel
     that opened meanwhile keeps the file (the pipe is refused — unless the
     pair races, in which case this road joins beside it); otherwise the
     pipe becomes THE channel and the WebRTC attempt is dropped (its late
     'open', if any, closes itself — see _bindChannel). */
  _pipeWon(pipe) {
    if (this._pipe !== pipe) return false;
    if (this.connected && this.dc && this.dc !== pipe && this.dc.readyState === 'open') {
      if (this._mpOn()) return this._joinLane(pipe);   /* a channel already carries the pair — this road joins the race beside it instead of replacing it */
      this._pipe = null; return false;
    }
    this._switchTo(pipe);
    return true;
  }
  /* Adopt a knocked-up road as an extra lane: it opens the moment this
     returns (PipeChannel commits synchronously), and _addLane puts it on
     the file already in flight. */
  _joinLane(ch) {
    ch.onopen = () => { this._addLane(ch); };
    return true;
  }
  /* Responder side: the initiator committed to the pipe, so its pc is gone —
     switching is the only way the link survives, even if our own WebRTC
     channel happened to open in between. */
  _pipeCommitted(pipe) {
    if (this._pipe !== pipe) return false;
    if (this._mpOn() && this.connected && this.dc && this.dc !== pipe && this.dc.readyState === 'open') return this._joinLane(pipe);
    this._switchTo(pipe);
    return true;
  }
  _switchTo(pipe) {
    this.lanes.delete(pipe);   /* whatever it was, it is THE channel now — a road that is both must never be streamed twice */
    const old = this.dc;
    if (old && old !== pipe && old.readyState === 'open') { this._onClosed(); try { old.close(); } catch {} }   /* park anything mid-flight on the channel being replaced (resume picks it up on the pipe) */
    this._bindChannel(pipe);   /* the pipe fires onopen right after this returns */
    this._dropPc();
    this._via = pipe.via || 'pipe';
  }
  _pipeActive() { return !!(this.dc && this.dc instanceof PipeChannel && this.dc.readyState !== 'closed'); }
  /* The discovery session (or the peer) behind the pipe is gone. */
  _pipeLost() { const p = this._pipe; if (p) p._lost(); }
  _dropPc() {
    const pc = this.pc; if (!pc) return;
    this.pc = null;
    pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = pc.ondatachannel = null;
    try { pc.close(); } catch {}
    if (this._fb && this._fb.turnTimer) { clearTimeout(this._fb.turnTimer); this._fb.turnTimer = null; }
  }
  /* Binary frame from the discovery session, addressed to us: [id from][kind][4 sid][payload]. */
  onPipeFrame(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < PIPE_HDR) return;
    const kind = new Uint8Array(buf, PIPE_ID_LEN, 1)[0], sid = pipeSid(buf);
    if (kind === PIPE.OPEN) {
      if (!PipeChannel.supported()) { PipeChannel.refuse(this.app, this.id, sid); return; }
      if (this._pipe) {
        const cur = this._pipe;
        if (sidEq(cur.sid, sid)) { if (!cur.initiator) cur.accept(buf); return; }   /* their retry of the knock we're already answering → ack again (an open pipe: accept is a no-op) */
        if (cur.initiator && cur.readyState === 'connecting' && this.owner) return;   /* both ends knocked at once: the owner's knock wins — keep waiting for their ack */
        /* a NEW session from the far end: whatever we hold with them is stale
           (their side of it is gone) — a live pipe goes down as a live
           channel (onclose → reset → resume), a half-open one is dropped */
        this._pipe = null;
        if (cur.readyState === 'open') cur._lost(); else cur.abandon();
      }
      if (!this._mpOn() && this.connected && this.dc && this.dc.readyState === 'open' && !(this.dc instanceof PipeChannel)) { PipeChannel.refuse(this.app, this.id, sid); return; }   /* WebRTC already carries this link — unless the pair races, in which case this road joins it */
      const pipe = this._pipe = new PipeChannel(this.app, this.id, false, sid);
      pipe.hook = () => this._pipeCommitted(pipe);
      pipe.onfail = () => { if (this._pipe === pipe) this._pipe = null; };
      pipe.accept(buf);
      return;
    }
    if (!this._pipe || !sidEq(this._pipe.sid, sid)) { if (kind === PIPE.DATA || kind === PIPE.TEXT || kind === PIPE.COMMIT) PipeChannel.refuse(this.app, this.id, sid); return; }   /* not ours (a session we already left) */
    this._pipe.onFrame(kind, buf);
  }

  /* ---- tunnel leg (see 1⅞) ----
     Roles are settled by one hello each way: HOST = the side with a
     machine (when both have one: the side driving the race, and between
     two drivers the owner), GUEST = the other. The PipeChannel initiator
     is the driver (between two drivers, the owner), exactly as the relay
     pipe picks its knocker. Sequence: hello ⇄ hello → the host dials its
     machine, invites the guest's key, opens its streams, sends the offer
     → the guest dials in, opens its streams → the initiator knocks (a
     guest knocks at once — the host's streams are already open; a host
     waits for the guest's 'ready'). From the knock on it is PipeChannel's
     own handshake, and the first open channel wins as on every leg. */
  _fbTun() {
    if (!this._race() || this._tunS) return;
    this._tunWhy = '';
    const tun = this.app.tunnel;
    if (!tun || !PipeChannel.supported()) { this._fbLegDead('tun'); return; }
    const st = this._tunState(true);
    this._roadsChanged();   /* the roads report says "dialling" from the first instant of the leg */
    Promise.resolve().then(() => tun.keygen()).then((key) => {
      if (this._tunS !== st) return;
      if (!key || typeof key.publicKey !== 'string') throw new Error('key');
      st.key = key;
      this._tunHello();
      if (st.pendingHello) { const m = st.pendingHello; st.pendingHello = null; this._tunRoles(m); return; }   /* the far end's hello beat our key */
      st.timer = setTimeout(() => { if (this._tunS === st && !st.peerSeen) this._tunFail('no-peer', true); }, TUN_HELLO_MS);
    }).catch(() => { if (this._tunS === st) this._tunFail('lib', true); });
  }
  _tunState(driver) {
    return this._tunS = { gen: this.gen, driver: !!driver, host: this.app._tunCanHost(), key: null, role: null, init: false, sid: '', client: null, wire: null,
      timer: null, peerSeen: false, peerHost: false, peerDriver: false, peerKey: '', offered: false, ready: false, knocked: false, pendingHello: null };
  }
  _tunHello() { const st = this._tunS; if (!st) return; this.app.signal(this.id, { kind: 'tun', t: 'hello', ask: st.driver, host: st.host, key: st.key ? st.key.publicKey : '' }); }
  _tunLive() { return !!(this.dc && this.dc.via === 'tunnel' && this.dc.readyState !== 'closed'); }
  _onTun(m) {
    const t = m && m.t;
    if (t === 'hello') {
      const declined = { kind: 'tun', t: 'hello', ask: false, host: false, key: '' };
      const tun = this.app.tunnel;
      if (!tun || !PipeChannel.supported()) { if (m.ask) this.app.signal(this.id, declined); return; }
      let st = this._tunS;
      if (!st) {
        if (!m.ask) return;   /* an answer to a leg this side no longer runs */
        /* The far end drives the race; this side answers with a key made now. */
        st = this._tunState(false);
        Promise.resolve().then(() => tun.keygen()).then((key) => { if (this._tunS !== st) return; if (!key || typeof key.publicKey !== 'string') throw new Error('key'); st.key = key; this._tunHello(); this._tunRoles(m); })
          .catch(() => { if (this._tunS === st) { this.app.signal(this.id, declined); this._tunFail('lib', true); } });
        return;
      }
      if (st.peerSeen) return;   /* one hello per leg settles the roles */
      if (!st.key) { st.pendingHello = m; return; }   /* our key is still being made (the driver's own start); roles are settled when it is */
      this._tunRoles(m);
      return;
    }
    if (t === 'offer') { this._tunOffer(m); return; }
    if (t === 'ready') { const st = this._tunS; if (st && st.role === 'host' && st.sid === m.sid) { st.ready = true; this._tunKnock(); } return; }
    if (t === 'fail') { if (this._tunS && !this._tunLive()) this._tunFail('peer', true); return; }
  }
  _tunRoles(m) {
    const st = this._tunS, tun = this.app.tunnel;
    if (!st || st.peerSeen) return;
    st.peerSeen = true;
    const keyOk = typeof m.key === 'string' && m.key.length <= 256 && (typeof tun.isKey === 'function' ? !!tun.isKey(m.key) : !!m.key);
    st.peerHost = !!m.host; st.peerDriver = !!m.ask; st.peerKey = keyOk ? m.key : '';
    /* Both flags are fixed when a leg is made and travel in its hello, so
       both sides compute the same answer from the same two pairs. */
    st.init = st.driver && (!st.peerDriver || this.owner);
    let host = null;
    if (st.host && !st.peerHost) host = 'me';
    else if (!st.host && st.peerHost) host = 'peer';
    else if (st.host && st.peerHost) host = (st.driver && st.peerDriver) ? (this.owner ? 'me' : 'peer') : (st.driver ? 'me' : 'peer');
    if (!host) { this._tunFail('no-machine', true); return; }
    if (host === 'me' && !st.peerKey) { this._tunFail('no-key', true); return; }
    st.role = host === 'me' ? 'host' : 'guest';
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { if (this._tunS === st && !this._tun) this._tunFail('timeout'); }, TUN_OFFER_MS);
    if (st.role === 'host') this._tunHost();
  }
  /* The io the provider feeds: bytes from the far end go to the wire (made
     once the endpoint is up), a closed stream kills it. */
  _tunIo(st) {
    return {
      onData: (chunk) => { if (this._tunS === st && st.wire) st.wire.feed(chunk); },
      onClose: (why) => { if (this._tunS === st && st.wire) st.wire.die(why || 'closed'); },
    };
  }
  async _tunHost() {
    const st = this._tunS, gen = this.gen, tun = this.app.tunnel;
    if (!st) return;
    st.sid = randHex(12);
    let ep = null;
    try { ep = await tun.host(st.sid, st.peerKey, this._tunIo(st)); } catch (e) { if (this._tunS === st) this._tunFail((e && e.message) || 'no-answer'); return; }
    if (this._tunS !== st || gen !== this.gen) { try { ep && ep.close(); } catch {} return; }
    if (!ep || typeof ep.write !== 'function') { this._tunFail('pipe'); return; }
    st.client = ep;
    if (!this._tunWire(ep)) return;
    st.offered = true;
    this.app.signal(this.id, { kind: 'tun', t: 'offer', sid: st.sid, offer: ep.offer });
    /* A new clock for the next phase: the guest's dial and its 'ready' (or, when the guest knocks, its knock). */
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { if (this._tunS === st && !this._tun) this._tunFail('timeout'); }, TUN_READY_MS);
  }
  async _tunOffer(m) {
    const st = this._tunS, gen = this.gen, tun = this.app.tunnel;
    if (!st || st.role !== 'guest' || st.offered) return;
    st.offered = true;
    /* The offer is here: the host's dials are behind us, this side's own dial is what the clock now measures. */
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { if (this._tunS === st && !this._tun) this._tunFail('timeout'); }, TUN_READY_MS);
    if (!tun || !st.key || typeof m.sid !== 'string' || !TUN_SID_RE.test(m.sid) || (typeof tun.isOffer === 'function' ? !tun.isOffer(m.offer) : !m.offer)) { this._tunFail('bad-offer'); return; }
    st.sid = m.sid;
    let ep = null;
    try { ep = await tun.guest(st.sid, m.offer, st.key, this._tunIo(st)); }
    catch (e) { if (this._tunS === st) this._tunFail((e && e.message) || 'no-answer'); return; }
    if (this._tunS !== st || gen !== this.gen) { try { ep && ep.close(); } catch {} return; }
    if (!ep || typeof ep.write !== 'function') { this._tunFail('pipe'); return; }
    st.client = ep;
    if (!this._tunWire(ep)) return;
    if (st.init) this._tunKnock();
    else this.app.signal(this.id, { kind: 'tun', t: 'ready', sid: st.sid });
  }
  /* Both streams of the session, framed for PipeChannel. */
  _tunWire(ep) {
    const st = this._tunS, gen = this.gen;
    const wire = st.wire = new TunWire(ep);
    wire.onFrame = (buf) => { if (this._tunS === st && gen === this.gen) this.onTunFrame(buf); };
    wire.onDead = (why) => {
      if (this._tunS !== st) return;
      const ch = this._tun;
      if (ch && ch.wire === wire) { if (ch.readyState === 'open') ch._lost(); else if (ch.readyState === 'connecting') ch._fail(); }   /* a live channel goes down as a live channel (onclose → reset → resume) */
      this._tunFail(why || 'wire');
    };
    if (st.role === 'host' && st.init && st.ready) this._tunKnock();
    return true;
  }
  /* The initiator's knock, once its streams are open and (host) the guest's are too. */
  _tunKnock() {
    const st = this._tunS;
    if (!st || !st.wire || !st.init || st.knocked) return;
    if (st.role === 'host' && !st.ready) return;
    if (!this._mpOn() && this.connected && this.dc && this.dc.readyState === 'open') { this._tunFail('moot', true); return; }   /* another road carries the link already (a racing pair wants this one too) */
    st.knocked = true;
    const ch = this._tun = new PipeChannel(this.app, this.id, true, null, st.wire);
    ch.hook = () => this._tunWon(ch);
    ch.onfail = () => { if (this._tun === ch) this._tun = null; this._tunFail('knock'); };
    ch.open();
  }
  _tunWon(ch) {
    if (this._tun !== ch) return false;
    if (this.connected && this.dc && this.dc !== ch && this.dc.readyState === 'open') {
      if (this._mpOn()) return this._joinLane(ch);
      this._tun = null; return false;
    }
    this._switchTo(ch);
    return true;
  }
  _tunCommitted(ch) {
    if (this._tun !== ch) return false;
    if (this._mpOn() && this.connected && this.dc && this.dc !== ch && this.dc.readyState === 'open') return this._joinLane(ch);
    this._switchTo(ch);
    return true;
  }
  /* A frame from the tunnel wire, [id from][kind][4 sid][payload] — the relay pipe's dispatch, on the tunnel's channel. */
  onTunFrame(buf) {
    const st = this._tunS;
    if (!st || !st.wire || !(buf instanceof ArrayBuffer) || buf.byteLength < PIPE_HDR) return;
    const kind = new Uint8Array(buf, PIPE_ID_LEN, 1)[0], sid = pipeSid(buf);
    if (kind === PIPE.OPEN) {
      if (!PipeChannel.supported()) { PipeChannel.refuse(this.app, this.id, sid, st.wire); return; }
      if (this._tun) {
        const cur = this._tun;
        if (sidEq(cur.sid, sid)) { if (!cur.initiator) cur.accept(buf); return; }
        if (cur.initiator && cur.readyState === 'connecting' && this.owner) return;
        this._tun = null;
        if (cur.readyState === 'open') cur._lost(); else cur.abandon();
      }
      if (!this._mpOn() && this.connected && this.dc && this.dc.readyState === 'open' && !(this.dc instanceof PipeChannel)) { PipeChannel.refuse(this.app, this.id, sid, st.wire); return; }
      const ch = this._tun = new PipeChannel(this.app, this.id, false, sid, st.wire);
      ch.hook = () => this._tunCommitted(ch);
      ch.onfail = () => { if (this._tun === ch) this._tun = null; };
      ch.accept(buf);
      return;
    }
    if (!this._tun || !sidEq(this._tun.sid, sid)) { if (kind === PIPE.DATA || kind === PIPE.TEXT || kind === PIPE.COMMIT) PipeChannel.refuse(this.app, this.id, sid, st.wire); return; }
    this._tun.onFrame(kind, buf);
  }
  /* The leg is over without a channel: tell the far end (unless it told us), let everything go, count the leg dead. */
  _tunFail(why, quiet) {
    const st = this._tunS;
    this._tunWhy = String(why || '').slice(0, 24);   /* what the roads report says when the tunnel leg is not up */
    this._roadsChanged();
    if (!st) return;
    if (!quiet && st.peerSeen) this.app.signal(this.id, { kind: 'tun', t: 'fail', why: String(why || '').slice(0, 40) });
    this._tunTeardown();
    this._fbLegDead('tun');
  }
  _tunTeardown() {
    const st = this._tunS;
    if (!st) return;
    this._tunS = null;
    clearTimeout(st.timer);
    const ch = this._tun;
    if (ch && ch !== this.dc) { this._tun = null; try { ch.close(); } catch {} }
    if (st.wire) st.wire.close();
    if (st.client) { try { st.client.close(); } catch {} }
  }

  /* ---- link leg (an encrypted temporary upload through the `link` store;
     the hosted build's store is R2 behind /api/upload, hence the names) ---- */
  _fbR2() {
    const link = this.app.link;
    if (!this._fb || !link) return;
    const cap = Number(link.maxBytes) || 0;
    for (const it of this.sendQueue) { if (it.status === 'queued' && !it._r2 && !it._r2Failed && it.file && it.file.size + 16 <= cap) this._r2Upload(it); }   /* +16: the AES-GCM tag rides inside the cap */
  }
  async _r2Upload(item) {
    const link = this.app.link;
    const ctrl = new AbortController(); const st = item._r2 = { ctrl, done: false, timer: null };
    try {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = await item.file.arrayBuffer();
      if (ctrl.signal.aborted) return;
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
      const rawKey = await crypto.subtle.exportKey('raw', key);
      if (ctrl.signal.aborted) return;
      const url = await link.put(new Blob([cipher], { type: 'application/octet-stream' }), { signal: ctrl.signal });
      if (typeof url !== 'string' || !url) throw new Error('upload');
      /* Claim only into a peer that can still be told: THIS object must be the
         live Peer for its id and the device still rostered — a transport that
         took the file meanwhile, or a peer that left (the file is parked for
         resume by device id), just lets the object expire. */
      if (item._r2 !== st || !(item.status === 'queued' || item.status === 'suspended') || this.app.peers.get(this.id) !== this || !this.app.roster.has(this.id) || !this._claimForLink(item)) return;
      st.done = true; item.status = 'sending'; item._via = 'link'; item.sent = item.file.size; item.samples = [];
      this._r2Items.set(item.id, item);
      this.app.signal(this.id, { kind: 'r2', id: item.id, tk: item.tk, tt: this.app._tokFor(this.dev, this.id), name: item.file.name, size: item.file.size, mime: item.file.type || 'application/octet-stream', url, key: b64u(rawKey), iv: b64u(iv) });
      this.app.ui.xferProgress(this.id, item, 1, 0, NaN, 'send');
      this.app.ui.xferVia(this.id, item, 'send', 'link');
      this.app.ui.xferHint(this.id, item, 'send', 'linkwait');
      st.timer = setTimeout(() => this._onR2Receipt({ id: item.id }, false), LINK_RECEIPT_MS);
    } catch {
      if (item._r2 === st && !st.done) item._r2 = null;
    } finally { if (!this.connected) this._fbCheckDead(); }
  }
  _claimForLink(item) {
    const i = this.sendQueue.indexOf(item);
    if (i >= 0) { this.sendQueue.splice(i, 1); return true; }
    return this.app._unpark(item);
  }
  _r2Abort() {
    for (const it of this.sendQueue) { if (it._r2 && !it._r2.done) { try { it._r2.ctrl.abort(); } catch {} it._r2 = null; } }
    if (this.dev) { const sus = this.app._susp.get(this.dev); if (sus) for (const it of sus.items) { if (it._r2 && !it._r2.done) { try { it._r2.ctrl.abort(); } catch {} it._r2 = null; } } }
  }
  _onR2Receipt(m, ok) {
    const id = m && m.id, item = this._r2Items.get(id); if (!item) return;
    this._r2Items.delete(id);
    const st = item._r2; if (st && st.timer) clearTimeout(st.timer);
    if (ok) { item.status = 'done'; this.app.ui.xferDone(this.id, item, 'send'); }
    else if (m && m.declined) { item.status = 'declined'; this.app.ui.xferError(this.id, item, 'send'); }
    else if (this.app.peers.get(this.id) !== this) { item.status = 'error'; this.app.ui.xferError(this.id, item, 'send'); }   /* this peer was dropped meanwhile — nowhere to retry */
    else {
      /* the link failed on their side (or no receipt in time) → back into the queue for a transport (the link leg won't retry this file) */
      item._r2 = null; item._r2Failed = true; item.sent = 0; item.samples = []; item.status = 'queued'; item._via = '';
      this.sendQueue.push(item);
      this.app.ui.xferHint(this.id, item, 'send', 'linkfail');
      this.ensureChannel(); this._pump();
      if (!this.connected && this._fb) this._fbRestart();   /* the race may already be over (legs dead) — run it again for this file instead of parking on a dead verdict */
    }
    this.app._reap(this);
  }
  /* Receiver: the sender delivered a file as an encrypted temporary link.
     Offers queue up (uploads run in parallel on the sender) and are taken one
     at a time, only while no other receive is in flight — a link file must
     never abort a stream that is mid-transfer, nor the other way round. */
  _onR2Offer(m) {
    if (!m || typeof m.id !== 'string' || !/^[0-9a-f]{10}$/.test(m.id)) return;
    const link = this.app.link;
    const size = Number(m.size), key = b64uDec(m.key), iv = b64uDec(m.iv);
    if (typeof m.url !== 'string' || !m.url || m.url.length > 2048 || !key || key.byteLength !== 32 || !iv || iv.byteLength !== 12 || !Number.isFinite(size) || size < 0) return;
    /* No store to fetch from, or past the cap this side accepts: say so now
       rather than leaving the sender to wait out its receipt clock. */
    if (!link || typeof link.get !== 'function' || size + 16 > (Number(link.maxBytes) || 0)) { this.app.signal(this.id, { kind: 'r2-failed', id: m.id }); return; }
    if (!this._r2Q) this._r2Q = [];
    if (this._r2Q.length >= 32 || this._r2Q.some((o) => o.id === m.id)) return;
    this._r2Q.push({ id: m.id, url: m.url, size, key, iv, name: m.name, mime: m.mime, tk: m.tk, tt: m.tt });
    this._r2Drain();
  }
  _r2Drain() {
    if (this._r2Busy || !this._r2Q || !this._r2Q.length) return;
    if (this.incoming && !this.incoming._ended) return;   /* a stream (or another prompt) owns the receive slot — retried when it settles */
    const o = this._r2Q.shift();
    this._r2Busy = true;
    this._r2Receive(o).catch(() => {}).then(() => { this._r2Busy = false; this._r2Drain(); });
  }
  async _r2Receive(o) {
    if (this.app._justDone(this.dev, o.id)) { this.app.signal(this.id, { kind: 'r2-received', id: o.id }); return; }
    const rec = { id: o.id, name: (typeof o.name === 'string' && o.name) ? o.name.slice(0, 255) : 'file', size: o.size, mime: (typeof o.mime === 'string' && o.mime) ? o.mime.slice(0, 128) : 'application/octet-stream', tk: (typeof o.tk === 'string' && o.tk.length >= 8 && o.tk.length <= 32) ? o.tk : '', _tt: /^[0-9a-f]{24}$/.test(o.tt || '') ? o.tt : '', received: 0, inFlight: 0, recvPaused: false, samples: [], chain: Promise.resolve(), sink: null, _cancelPrompt: null, _via: 'link' };
    this.incoming = rec;   /* the receive slot is held only through the prompts — the download below runs beside any stream */
    this.app.ui.addXfer(this.id, this.name, rec, 'recv');
    this.app.ui.xferVia(this.id, rec, 'recv', 'link');
    this.app.ui.xferHint(this.id, rec, 'recv', 'linkget');
    await this._accept(rec);   /* first-contact prompt + sink; its `ready` frame is a no-op with no channel (the link needs none) */
    if (this.incoming === rec) this.incoming = null;
    if (rec._ended || !rec.sink) { this.app.signal(this.id, { kind: 'r2-failed', id: o.id, declined: rec.status === 'declined' }); return; }
    if (!this._r2Live) this._r2Live = new Map();
    this._r2Live.set(o.id, rec);   /* a channel offer for the same id while this runs wins (see _onMeta) */
    const ctrl = new AbortController();
    try {
      const total = o.size + 16;
      const cipher = await this._r2Fetch(o.url, total, ctrl, (got) => {
        if (rec._ended) { ctrl.abort(); return; }
        rec.received = Math.min(got, o.size); this._sample(rec, got);
        const { rate, eta } = this._stats(rec, total); this.app.ui.xferProgress(this.id, rec, got / total, rate, eta, 'recv');
      });
      if (rec._ended) return;
      const k = await crypto.subtle.importKey('raw', o.key, { name: 'AES-GCM' }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: o.iv }, k, cipher);
      if (plain.byteLength !== o.size) throw new Error('size');
      if (rec._ended) return;
      rec.received = o.size;
      await rec.sink.write(plain);
      await rec.sink.close();
      rec._ended = true;
      this.app._markDone(this.dev, rec.id, rec.tk, LINK_DONE_TTL);
      this.app.ui.xferDone(this.id, rec, 'recv');
      this.app.signal(this.id, { kind: 'r2-received', id: rec.id });
    } catch {
      if (!rec._ended) { rec._ended = true; this._teardownSink(rec); this.app.ui.xferError(this.id, rec, 'recv'); this.app.signal(this.id, { kind: 'r2-failed', id: o.id }); }
    } finally { if (this._r2Live && this._r2Live.get(o.id) === rec) this._r2Live.delete(o.id); this.app._reap(this); }
  }
  /* The store's get() may answer with a Response, a ReadableStream, a Blob or
     an ArrayBuffer; read whichever it is into one buffer, bounded by `total`. */
  async _r2Fetch(url, total, ctrl, onProgress) {
    let src = await this.app.link.get(url, { signal: ctrl.signal });
    if (src && typeof src.ok === 'boolean') { if (!src.ok || !src.body) throw new Error('download'); src = src.body; }
    if (src instanceof Blob) src = src.stream();
    if (src instanceof ArrayBuffer) { if (src.byteLength > total) throw new Error('oversize'); onProgress(src.byteLength); return new Uint8Array(src); }
    if (!src || typeof src.getReader !== 'function') throw new Error('download');
    const parts = []; let got = 0;
    const reader = src.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.byteLength;
      if (got > total) { try { await reader.cancel(); } catch {} throw new Error('oversize'); }
      onProgress(got);
      if (ctrl.signal.aborted) { try { await reader.cancel(); } catch {} throw new Error('aborted'); }
    }
    const out = new Uint8Array(got); let at = 0; for (const c of parts) { out.set(c, at); at += c.byteLength; }
    return out;
  }
  /* This peer is being torn down: queued link offers are dropped and live link downloads abandoned (their sinks released) — nobody is left to take the receipt. */
  _r2AbortRecv() {
    if (this._r2Q) this._r2Q.length = 0;
    if (this._r2Live) { for (const [, rec] of this._r2Live) { if (!rec._ended) { rec._ended = true; releaseSink(rec); this.app.ui.xferError(this.id, rec, 'recv'); } } this._r2Live.clear(); }
  }
}

/* ===================================================================== *
 *  3. TRANSFER NODE — one endpoint: discovery sessions + peer table +
 *     resume state + first-contact trust + the injected transports.
 *
 *  new TransferNode({
 *    name,        // display name announced to peers (default: deviceLabel())
 *    dev,         // stable device id ([a-z0-9]{8,16}) — resume identity across
 *                 // reconnects; default random per instance
 *    code,        // your own room code (namespaces the discovery channel)
 *    discovery,   // (framedName, code) => discovery session
 *                 // (default: BroadcastChannelDiscovery)
 *    iceServers,  // RTCPeerConnection iceServers for the FIRST attempt
 *                 // (default [] = LAN only; STUN entries cross NATs)
 *    relayIceServers,  // TURN entries for the fallback's relay leg: an array,
 *                 // or an async function returning one (or {iceServers,
 *                 // expiresAt}) — called only when direct is judged dead
 *    acceptRelayServers(list) → list|null,  // vet a credential the PEER hands
 *                 // over; default refuses (the leg still runs on your own)
 *    link,        // { maxBytes, put(blob,{signal})→url, get(url,{signal}) } —
 *                 // the upload-link leg's store; absent = no link leg
 *    tunnel,      // the tunnel provider (see README); absent = no tunnel leg
 *    openSink,    // async (peer, rec) => sink | null — where a receive lands
 *                 // (default: MemSink, refusing past memCap)
 *    memCap,      // default sink's refusal cap (default MEM_HARD_CAP)
 *    ui,          // presentation callbacks, all optional:
 *      setStatus(state)                    'searching'|'ready'|'dial'|'offline'|'off'
 *      renderRoster(rosterMap)             the device list changed
 *      dialState(code, state)              a dialled room: 'searching'|'ready'|'offline'|'closed'
 *      peerState(id, state)                'connecting'|'connected'|'failed'
 *      peerRoads(id, {list, tun, mp})      which roads carry a pair (see roads())
 *      addXfer(peerId, peerName, item, dir)          a transfer row appeared
 *      xferProgress(peerId, item, frac, rate, eta, dir)
 *      xferDone(peerId, item, dir) / xferError(peerId, item, dir)
 *      xferSuspend(peerId, item, dir)      parked after a drop, resumable
 *      rekeyXfer(oldId, newId, item, dir)  a parked transfer resumed under a
 *                                          new connection id
 *      xferAwait(peerId, item)             receiver is at its accept prompt
 *      xferVia(peerId, item, dir, via)     'rtc'|'turn'|'pipe'|'tunnel'|'race'|'link'
 *      xferHint(peerId, item, dir, key)    'linkwait'|'linkget'|'linkfail'
 *      xferDrop(peerId, item, dir)         a link download was superseded by
 *                                          a channel offer of the same file
 *      promptAccept(peerId, rec) → Promise reject(Error('declined')) to refuse;
 *                                          may set rec._cancelPrompt to be torn
 *                                          down if the offer dies meanwhile
 *      downloadBlob(blob, name)            a default-sink (in-memory) receive
 *                                          finished — hand the file over
 *  })
 *
 *  Visibility (mode): 'on' — your own room is open, anyone holding your
 *  code finds you; 'dial' (out only) — you host nothing and nobody can find
 *  you by code, but every room you dial lives and you can send into it;
 *  'off' — no session at all. Being findable and being able to reach out
 *  are separate settings; the device you dial does see you inside ITS
 *  room, and the channel it opens is two-way.
 * ===================================================================== */

export class TransferNode {
  constructor(opts) {
    opts = opts || {};
    this.name = String(opts.name || deviceLabel());
    this.dev = devOk(opts.dev) ? opts.dev : randHex(5);
    this.code = opts.code ? cleanCode(opts.code) : '';
    this.iceServers = Array.isArray(opts.iceServers) ? opts.iceServers : [];
    this.relayIceServers = (Array.isArray(opts.relayIceServers) || typeof opts.relayIceServers === 'function') ? opts.relayIceServers : null;
    this.acceptRelayServers = typeof opts.acceptRelayServers === 'function' ? opts.acceptRelayServers : (() => null);
    this.link = (opts.link && typeof opts.link.put === 'function') ? opts.link : null;
    this.tunnel = (opts.tunnel && typeof opts.tunnel.keygen === 'function' && typeof opts.tunnel.host === 'function' && typeof opts.tunnel.guest === 'function') ? opts.tunnel : null;
    this.makeDiscovery = typeof opts.discovery === 'function' ? opts.discovery : BroadcastChannelDiscovery;
    this.memCap = (Number.isFinite(opts.memCap) && opts.memCap > 0) ? opts.memCap : MEM_HARD_CAP;
    this.openSink = opts.openSink || (async (peer, rec) => (rec.size > this.memCap ? null : new MemSink(rec.name, rec.mime, (blob, name) => this.ui.downloadBlob(blob, name))));
    this.ui = Object.assign({
      setStatus() {}, renderRoster() {}, dialState() {}, peerState() {}, peerRoads() {},
      addXfer() {}, xferProgress() {}, xferDone() {}, xferError() {},
      xferSuspend() {}, xferAwait() {}, rekeyXfer() {}, xferVia() {}, xferHint() {}, xferDrop() {}, downloadBlob() {},
      promptAccept() { return Promise.resolve(); },
    }, opts.ui || {});
    this.mode = 'off';
    this.selfId = null; this.room = null; this.discovery = null;   /* your own room's session (tag 'own') */
    this._own = null; this.dials = new Map();                       /* code → { disc, selfId } (tag 'dial:'+code) */
    this.peers = new Map(); this.roster = new Map(); this.peerSession = new Map();
    this._susp = new Map(); this._doneRecent = new Map();
    this._relayOwn = null; this._relayShared = null; this._relayInflight = null;
  }

  /* The name announced through discovery: display name framed with the stable
     device id (see NAME_SEP above). */
  announceName() {
    const base = String(this.name || 'device').split(NAME_SEP).join('').slice(0, 40);   /* strip any US so a name can't corrupt the framing */
    return base + NAME_SEP + NAME_SEP + NAME_SEP + this.dev;
  }

  /* ---- sessions ----
     Each session (your own room, each dialled room) is one discovery
     session; peers remember which session they were met through so signals
     and pipe frames go back the way they came. Callbacks from a session
     we've already moved past are ignored: a queued welcome/peer/signal from
     an old transport must not clobber a newer session. Discovery dying does
     NOT touch live peers — file bytes run peer-to-peer and don't need the
     session once a channel is open; open it again to rejoin (the in-page
     build layers auto-reconnect with backoff on top of exactly this) —
     only a relay pipe dies with its session. */
  _slot(tag) { return tag === 'own' ? this._own : this.dials.get(tag.slice(5)) || null; }
  _openSession(tag, code) {
    const d = this.makeDiscovery(this.announceName(), code);
    const slot = { disc: d, selfId: null, code };
    const live = () => this._slot(tag) === slot && slot.disc === d;
    const state = (s) => { if (tag === 'own') this.ui.setStatus(s); else this.ui.dialState(code, s); };
    state('searching');
    d.onWelcome = (selfId, peers, room) => {
      if (!live()) return;
      slot.selfId = selfId; if (tag === 'own') { this.selfId = selfId; this.room = room || null; }
      this._clearRoster(tag); (peers || []).forEach((p) => { if (p.id !== selfId) this._rosterAdd(p, tag); }); this._reconcile(tag);
      this.ui.renderRoster(this.roster); state('ready');
    };
    d.onPeerJoined = (p) => { if (!live() || !p || p.id === slot.selfId) return; this._rosterAdd(p, tag); this.ui.renderRoster(this.roster); };
    d.onPeerLeft = (id) => { if (!live()) return; this._rosterLeft(id); this.ui.renderRoster(this.roster); };
    d.onSignal = (from, payload) => { if (!live()) return; if (!this.peerSession.has(from)) this.peerSession.set(from, tag); this._peer(from).onSignal(payload); };
    d.onPipe = (from, buf) => { if (!live()) return; if (!this.peerSession.has(from)) this.peerSession.set(from, tag); this._peer(from).onPipeFrame(buf); };
    d.onClose = () => {
      if (!live()) return;
      slot.disc = null; slot.selfId = null; if (tag === 'own') { this.discovery = null; this.selfId = null; }
      this._pipesLost(tag);   /* relay pipes rode this session — a P2P channel survives, a pipe does not */
      state('offline');
    };
    if (tag === 'own') { this._own = slot; this.discovery = d; }
    else this.dials.set(code, slot);
    return slot;
  }
  _closeSession(tag) {
    const slot = this._slot(tag); if (!slot) return;
    const d = slot.disc; slot.disc = null; slot.selfId = null;
    if (tag === 'own') { this._own = null; this.discovery = null; this.selfId = null; }
    else this.dials.delete(slot.code);
    try { d && d.close(); } catch {}
    this._pipesLost(tag);
    this._clearRoster(tag); this._reconcile(tag);   /* idle peers of this session go; a busy P2P channel finishes as an orphan */
    this.ui.renderRoster(this.roster);
  }
  /* Open your own room (mode 'on'). Idempotent. */
  join() {
    this.mode = 'on';
    if (!(this._own && this._own.disc)) this._openSession('own', this.code);
    return this;
  }
  /* Dial another device's room by its code: a separate session beside your
     own (if any). With no own room open, this is "out only". Idempotent per
     code; returns false for a code outside the grammar or your own. */
  dial(code) {
    code = cleanCode(code);
    if (code.length < CODE_LEN) return false;
    if (this.mode === 'off') this.mode = 'dial';   /* dialling from a cold stop opens the out-only door, not your own room */
    if (this.mode === 'on' && code === this.code) return true;   /* your own code → already in that room via your own session */
    const cur = this.dials.get(code);
    if (cur && cur.disc) return true;
    this._openSession('dial:' + code, code);
    return true;
  }
  /* Leave ONE dialled room (its peers go unless a transfer is still riding a P2P channel). */
  hangUp(code) { code = cleanCode(code); if (!this.dials.has(code)) return; this._closeSession('dial:' + code); this.ui.dialState(code, 'closed'); }
  /* 'on': open your own room. 'dial' (out only): leave your own room, keep
     every dialled one — parked transfers are NOT expired (the only way a
     parked peer can come back is through a room you yourself dial, an
     affirmative act). 'off': close everything and release every held sink
     and File — an explicit stop. */
  setMode(m) {
    m = (m === 'on' || m === 'dial') ? m : 'off';
    if (m === 'on') { this.join(); return; }
    if (m === 'dial') { this.mode = 'dial'; this._closeSession('own'); this.ui.setStatus('dial'); return; }
    this.close();
  }
  /* Leave every session and tear everything down. Teardowns park in-flight
     work first (they may hold open sinks / File handles), so the suspended
     set is expired AFTER them — closing a node must abort every held sink,
     never leave one waiting on a resume that can't come. */
  close() {
    this.mode = 'off';
    const sessions = [this._own, ...this.dials.values()].filter(Boolean);
    this._own = null; this.discovery = null; this.selfId = null; this.dials.clear();
    for (const s of sessions) { try { s.disc && s.disc.close(); } catch {} }
    for (const [id, p] of [...this.peers]) { try { p.teardown(); } catch {} this.peers.delete(id); }
    this.roster.clear(); this.peerSession.clear();
    this._expireAllSuspended();
    this.ui.renderRoster(this.roster);
    this.ui.setStatus('off');
  }

  /* ---- roster ---- */
  _clearRoster(tag) { for (const [id, e] of [...this.roster]) { if (!tag || e.tag === tag) this.roster.delete(id); } }
  /* After a welcome repaints a session's roster: any Peer of that session
     whose row did NOT come back left while we were away (its peer-left
     never reached us). Busy live channel → orphan (finish, then reap);
     otherwise tear down now — else the Peer object idles in `peers` forever. */
  _reconcile(tag) {
    for (const [id, pe] of [...this.peers]) {
      if (this.roster.has(id)) continue;
      if (tag && this.peerSession.get(id) !== tag) continue;
      if (pe.connected && pe.busy()) { pe.orphaned = true; continue; }
      pe.teardown(); this.peers.delete(id); this.peerSession.delete(id);
    }
  }
  _rosterAdd(p, tag) {
    if (!p || !p.id) return;
    const m = parsePeerName(p.name);
    if (m.dev && m.dev === this.dev) return;   /* our own stale connection echoed back by the transport (ids rotate per connect), or our own other session in a room we dialled — never roster yourself */
    this.roster.set(p.id, { id: p.id, name: m.name, dev: m.dev, tag });
    this.peerSession.set(p.id, tag);
    const pe = this.peers.get(p.id);
    if (pe) {
      pe.orphaned = false; pe.name = m.name;   /* row is back — cancel any pending drain-reap */
      if (m.dev && !pe.dev) { pe.dev = m.dev; this._migrateTrust(p.id, m.dev); if (!pe.dc && m.dev !== this.dev) pe.owner = this.dev < m.dev; }   /* Peer was built from a signal that beat the roster (dev unknown → legacy owner); now that dev is known, re-derive ownership BEFORE any channel exists, or the two ends disagree on who offers (double-channel glare / neither offers), and move any conn-id-keyed trust to the stable dev key */
      else if (m.dev) pe.dev = m.dev;
    }
    if (m.dev && this._susp.has(m.dev)) queueMicrotask(() => { if (this._susp.has(m.dev) && this.roster.has(p.id)) this._peer(p.id).ensureChannel(); });   /* the device we hold suspended transfers for is back (maybe under a fresh id) → redial so resume can run */
  }
  _rosterLeft(id) {
    this.roster.delete(id); this.peerSession.delete(id);
    const pe = this.peers.get(id); if (!pe) return;
    pe._pipeLost();   /* the relay drops pipe frames for a peer that left — a pipe-carried link is dead (its transfers park for resume); P2P channels survive below */
    if (pe.connected && pe.busy()) { pe.orphaned = true; return; }   /* the discovery session flapped, but the DataChannel is P2P and still moving bytes — let the transfer finish; reaped on drain */
    pe.teardown(); this.peers.delete(id);
    if (!pe.dev) this._forgetPeerTok(id);   /* a conn-id-keyed trust with no stable dev can never be re-matched — drop it so p: entries don't accumulate (dev-keyed trust survives a reconnect and stays) */
  }

  /* ---- signalling + peers ---- */
  _sessionOf(id) {
    const tag = this.peerSession.get(id);
    const slot = tag ? this._slot(tag) : (this._own || this.dials.values().next().value || null);   /* untagged → best-effort */
    return slot ? { disc: slot.disc, selfId: slot.selfId } : { disc: null, selfId: null };
  }
  signal(to, payload) { const s = this._sessionOf(to); if (s.disc) s.disc.signal(to, payload); }
  /* relay-pipe frame → the session that owns this peer; false when there is none to carry it */
  _pipeSend(to, frame) { const s = this._sessionOf(to); return !!(s.disc && typeof s.disc.pipe === 'function' && s.disc.pipe(to, frame)); }
  _pipesLost(tag) { for (const [id, p] of this.peers) { if (this.peerSession.get(id) === tag || (!this.roster.has(id) && p._pipeActive())) p._pipeLost(); } }
  _peer(id) {
    let p = this.peers.get(id);
    if (!p) {
      const info = this.roster.get(id) || { name: 'device' };
      p = new Peer(this, id, info.name);
      p.dev = info.dev || '';
      /* glare avoidance: when both ends advertise a stable device id, ownership
         compares those (stable across discovery reconnects — no owner flip
         mid-session). Legacy fallback compares our transport id in the
         session this peer was met through with the peer's connection id. */
      p.owner = (p.dev && p.dev !== this.dev) ? (this.dev < p.dev) : (String(this._sessionOf(id).selfId || '') < id);
      this.peers.set(id, p);
    }
    return p;
  }
  /* Queue files to a rostered device (File objects, or Blobs carrying a
     `name`). Bytes flow once the channel opens. */
  sendTo(id, files) {
    if (!files || !files.length) return;
    /* Don't build a Peer while its session has no selfId (e.g. a roster tile
       lingering during a rejoin): glare would resolve ownership from '' < id,
       open a data channel, and route the offer to a dead session — a
       permanently stuck send. */
    const s = this._sessionOf(id);
    if (!(s.disc && s.selfId)) return;
    /* trust is granted from _pump once the channel is open (the grant frame
       needs the DTLS channel) — you chose to send TO this device, so its
       transfers back need no first-contact confirm */
    this._peer(id).enqueue(files);
  }

  /* ---- relay (TURN) credential for the fallback's relay leg ----
     Never fetched up front: the first attempt is STUN-only, and the fetch
     runs as one of the fallback legs once that attempt is judged dead (a
     minted credential may be a scarce allowance). The credential is handed
     to the peer over signalling ({kind:'turn'}) so a pair that can only
     mint on one side still relays on both; one the PEER hands us goes into
     a separate slot — vetted by acceptRelayServers, never replacing or
     blocking our own, capped at RELAY_SHARED_MAX_MS — so a hostile room
     member can at worst hand us a relay that doesn't work. */
  _relayOwnFresh() { const r = this._relayOwn; return (r && Date.now() < r.expiresAt) ? r : null; }
  _relaySharedFresh() { const r = this._relayShared; return (r && Date.now() < r.expiresAt) ? r : null; }
  /* The relay entry ICE may use right now: our own credential first, else a peer-shared one. */
  _relayNow() { const o = this._relayOwnFresh(); if (o) return o.servers; const s = this._relaySharedFresh(); return s ? s.servers : null; }
  _relayFetch() {
    if (!this.relayIceServers) return Promise.resolve(false);
    if (this._relayOwnFresh()) return Promise.resolve(true);
    if (this._relayInflight) return this._relayInflight;
    const src = this.relayIceServers;
    const p = Promise.resolve().then(() => (typeof src === 'function' ? src() : src)).then((d) => {
      const servers = Array.isArray(d) ? d : (d && Array.isArray(d.iceServers) ? d.iceServers : null);
      if (!servers || !servers.length) return false;
      const exp = (d && typeof d.expiresAt === 'number' && d.expiresAt > Date.now()) ? d.expiresAt : Date.now() + 60 * 60 * 1000;
      this._relayOwn = { servers, expiresAt: exp };
      /* The credential lands after the pc was built and judged stuck:
         install it into every live attempt now — merely caching it only
         helps the NEXT pc and leaves the current file frozen at 0%. Only a
         peer whose direct attempt is already judged dead — never a pc still
         in its direct window. */
      for (const p of this.peers.values()) { if (p._fb) p._adoptRelay(); }
      return true;
    }).catch(() => false).finally(() => { if (this._relayInflight === p) this._relayInflight = null; });
    this._relayInflight = p;
    return p;
  }
  _relayAdoptShared(m) {
    if (this._relayOwnFresh() || !m || !Array.isArray(m.iceServers) || !m.iceServers.length || m.iceServers.length > 8) return false;
    const now = Date.now();
    if (typeof m.expiresAt !== 'number' || !(m.expiresAt > now)) return false;
    let list = null; try { list = this.acceptRelayServers(m.iceServers); } catch { list = null; }
    if (!Array.isArray(list) || !list.length) return false;
    this._relayShared = { servers: list, expiresAt: Math.min(m.expiresAt, now + RELAY_SHARED_MAX_MS) };
    return true;
  }
  _tunCanHost() { const t = this.tunnel; if (!t) return false; try { return typeof t.canHost === 'function' ? !!t.canHost() : true; } catch { return false; } }

  /* ---- suspended transfers: survive a dropped connection, resume by device id ----
     When a peer's channel dies mid-transfer, its work is PARKED here rather than
     failed: the sender keeps the File handles + queue, the receiver keeps its OPEN
     sink. When the same device (stable dev id, whatever its new connection id)
     reconnects, the sender re-offers each file under its original id and the
     receiver answers ready{off:<bytes settled>}, so the stream picks up mid-file
     instead of starting over. RESUME_GRACE bounds how long the File handles /
     open sink are held. */
  _suspendFrom(peer) {
    const dev = peer.dev;
    if (!dev) return;   /* legacy peer (no device id) → keep the old fail-fast path */
    const items = [];
    if (peer.sending && peer.sending.status === 'sending') { peer.sending.status = 'suspended'; items.push(peer.sending); }
    for (const it of peer.sendQueue.splice(0)) { if (it.status === 'queued') { it.status = 'suspended'; items.push(it); } else peer.sendQueue.push(it); }
    let rec = null;
    const r = peer.incoming;
    if (r && !r._ended && r.sink) { rec = r; peer.incoming = null; }   /* sink open (past any accept gate) → hold it; the prompt path still cancels via _abort */
    if (!items.length && !rec) return;
    let s = this._susp.get(dev);
    if (!s) { s = { items: [], rec: null }; this._susp.set(dev, s); }
    else { try { clearTimeout(s.timer); } catch {} }
    s.items.push(...items);
    if (rec) {
      if (s.rec && s.rec !== rec && !s.rec._ended) { const o = s.rec; o._ended = true; releaseSink(o); this.ui.xferError(o._susFrom, o, 'recv'); }   /* superseded parked receive (sender re-offered something newer) */
      s.rec = rec; rec._susFrom = peer.id;
    }
    s.timer = setTimeout(() => this._susExpire(dev), RESUME_GRACE);
    for (const it of items) { it._susFrom = peer.id; this.ui.xferSuspend(peer.id, it, 'send'); }
    if (rec) this.ui.xferSuspend(peer.id, rec, 'recv');
    /* If the device is still rostered, redial shortly — resolve its CURRENT id by dev
       at fire time (it may have re-joined under a fresh id whose peer-joined predated
       this suspend, so no kick fired) — otherwise resume waits for peer-joined/welcome. */
    const oldId = peer.id;
    setTimeout(() => {
      if (!this._susp.get(dev)) return;
      let tid = this.roster.has(oldId) ? oldId : null;
      if (!tid) { for (const e of this.roster.values()) { if (e.dev === dev) { tid = e.id; break; } } }
      if (tid) { try { this._peer(tid).ensureChannel(); } catch {} }
    }, 1200);
  }
  _susExpire(dev) {
    const s = this._susp.get(dev); if (!s) return;
    this._susp.delete(dev); try { clearTimeout(s.timer); } catch {}
    for (const it of s.items) { if (it.status === 'suspended') { it.status = 'error'; this.ui.xferError(it._susFrom, it, 'send'); } }
    const rec = s.rec;
    if (rec && !rec._ended) { rec._ended = true; releaseSink(rec); this.ui.xferError(rec._susFrom, rec, 'recv'); }   /* releaseSink drains queued writes, then aborts (an FSA sink discards its partial file) */
  }
  _expireAllSuspended() { for (const dev of [...this._susp.keys()]) this._susExpire(dev); }
  /* Pull a parked (suspended) send out of its resume bucket — the link leg delivered it another way. */
  _unpark(item) {
    for (const [dev, s] of this._susp) {
      const i = s.items.indexOf(item); if (i < 0) continue;
      s.items.splice(i, 1);
      if (!s.items.length && !s.rec) { try { clearTimeout(s.timer); } catch {} this._susp.delete(dev); }
      return true;
    }
    return false;
  }
  /* A channel to this device just opened — hand it everything parked under its
     dev id. Send items rejoin the queue (the re-offer carries the original item
     id); a parked receive stays here until the sender's meta re-offer claims it
     via _claimRecv. */
  _resumeInto(peer) {
    if (!peer.dev) return;
    const s = this._susp.get(peer.dev); if (!s) return;
    const items = s.items.filter(it => it.status === 'suspended'); s.items = [];
    if (s.rec && !s.rec._ended) { try { clearTimeout(s.timer); } catch {} s.timer = setTimeout(() => this._susExpire(peer.dev), RESUME_GRACE); }
    else { try { clearTimeout(s.timer); } catch {} this._susp.delete(peer.dev); }
    /* Offered items resume strictly: their ready must echo the tk only the original
       receiver ever saw. Never-offered queue items have no shared secret — when an
       offered sibling anchors the group they wait for ITS verification; a group with
       no anchor (drop before the first meta, a ms-wide window) rides devid trust. */
    const anchored = items.some(it => it._everOffered);
    for (const it of items) {
      it.status = 'queued'; it.samples = [];
      if (it._everOffered) it._resumed = true; else if (anchored) it._needVerify = true;
      this.ui.rekeyXfer(it._susFrom, peer.id, it, 'send'); peer.sendQueue.push(it);
    }
  }
  _claimRecv(dev, m) {
    if (!dev || m.r !== 1) return null;   /* only a resume-aware sender re-offers with a reused id; without r:1 an id match would be coincidence */
    const s = this._susp.get(dev); if (!s || !s.rec) return null;
    const rec = s.rec;
    /* No tk check here — the re-offer deliberately never repeats it. The match key
       (id+name+size) itself only ever travelled the original private channel, so a
       devid spoofer can't hit it; proof runs the OTHER way (our ready echoes rec.tk,
       and the sender streams to no one who can't). */
    if (rec._ended || rec.id !== m.id || rec.name !== (m.name || 'file') || rec.size !== Number(m.size)) return null;
    s.rec = null;
    if (!s.items.length) { try { clearTimeout(s.timer); } catch {} this._susp.delete(dev); }
    return { rec, fromId: rec._susFrom };
  }
  /* Receipts can die with the connection: remember what we finished (per device) for as
     long as the sender might re-offer it (RESUME_GRACE — a shorter window would let a
     late reconnect re-receive a completed file) — with its tk, so the re-ack carries proof.
     ttl: a link-delivered file is remembered for as long as its sender may still
     re-offer it (receipt wait + resume grace). */
  _markDone(dev, id, tk, ttl) { if (!dev) return; const now = Date.now(); for (const [k, e] of this._doneRecent) { if (now - e.t > (e.ttl || RESUME_GRACE)) this._doneRecent.delete(k); } this._doneRecent.set(dev + ':' + id, { t: now, tk: tk || '', ttl: ttl || RESUME_GRACE }); }
  _justDone(dev, id) { if (!dev) return null; const k = dev + ':' + id, e = this._doneRecent.get(k); if (!e) return null; if (Date.now() - e.t > (e.ttl || RESUME_GRACE)) { this._doneRecent.delete(k); return null; } return e; }
  /* An orphaned peer (roster row gone, kept only for its in-flight transfer) is torn
     down once it drains. Reset `orphaned` first — teardown re-enters here via _onClosed. */
  _reap(peer) {
    if (!peer.orphaned || peer.busy()) return;
    peer.orphaned = false;
    peer.teardown();
    if (this.peers.get(peer.id) === peer) { this.peers.delete(peer.id); this.peerSession.delete(peer.id); }
  }

  /* ---- first-contact trust: the FIRST file from a device must be accepted
     (ui.promptAccept); a device you've exchanged files with — you sent to it,
     or you accepted from it — flows without asking. In-memory only: a fresh
     node starts over, which is the safe default.

     The device id rides the public name frame, so it must never BE the trust
     proof (a room member could claim a trusted device's id). Granting trust
     mints a per-device secret token and hands it to the peer over the
     DTLS-private channel ({t:'trust'}) — or, for a link-delivered file that
     has no channel, over signalling ({kind:'ctl'}); skipping the prompt
     later requires the meta frame to echo that token (`tt`). The public dev
     id is only the lookup key. Same pattern as the per-transfer resume tk. */
  /* Both trust maps are bounded: p:<conn-id> keys churn on reconnect (migrated
     to d:<dev> once the name frame lands, dropped when a peer leaves), but a
     hostile room member could still spam grant/echo frames — hard-cap both and
     evict oldest-first. */
  _capTrust(m) { const CAP = 256; while (m.size > CAP) { const k = m.keys().next().value; m.delete(k); } }
  _grantTrust(p) {
    const key = p.dev ? 'd:' + p.dev : 'p:' + p.id;
    const t = this._trustedDevs || (this._trustedDevs = new Map());
    let tok = t.get(key);
    if (!tok) { tok = randHex(12); t.set(key, tok); this._capTrust(t); }
    p._ctl({ t: 'trust', tok });
  }
  /* Peer side of a grant: remember the token this device handed us so our next
     offers to it can echo it. Reject anything not our own 24-hex token shape —
     a peer can't inject arbitrary strings to bloat the map or clobber a key. */
  _takeTok(dev, peerId, tok) {
    if (!/^[0-9a-f]{24}$/.test(tok || '')) return;
    const t = this._peerToks || (this._peerToks = new Map());
    t.set(dev ? 'd:' + dev : 'p:' + peerId, tok); this._capTrust(t);
  }
  _tokFor(dev, peerId) {
    const t = this._peerToks;
    return t ? (t.get('d:' + dev) || t.get('p:' + peerId)) : undefined;
  }
  isTrusted(dev, peerId, tok) {
    if (!/^[0-9a-f]{24}$/.test(tok || '')) return false;
    const t = this._trustedDevs;
    return !!t && ((dev && t.get('d:' + dev) === tok) || (peerId && t.get('p:' + peerId) === tok));
  }
  /* The name frame arrived after the Peer was built: move trust learned under
     the transient p:<conn-id> to the stable d:<dev>, so a reconnect with a
     fresh id still recognises the device (and p: entries don't pile up). */
  _migrateTrust(id, dev) {
    for (const m of [this._trustedDevs, this._peerToks]) {
      if (!m) continue;
      const ok = 'p:' + id, nk = 'd:' + dev;
      if (m.has(ok)) { if (!m.has(nk)) m.set(nk, m.get(ok)); m.delete(ok); }
    }
  }
  _forgetPeerTok(id) {
    if (this._trustedDevs) this._trustedDevs.delete('p:' + id);
    if (this._peerToks) this._peerToks.delete('p:' + id);
  }
}
