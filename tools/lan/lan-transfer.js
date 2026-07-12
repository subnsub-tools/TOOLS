/* LAN file transfer — direct device-to-device file transfer over WebRTC,
   with pluggable discovery. Core engine of the Transfer tool on
   subnsub.com (/lan), kept in lockstep with the in-page version.

   Layers (mirroring the in-page tool):
   1. Discovery — roster + targeted signal relay behind a small callback
      contract (below). The BroadcastChannel implementation ships here:
      every tab of one browser acts as one LAN, so the whole engine runs —
      and is auditable end-to-end — with no server at all. The production
      WebSocket discovery implements the same contract against a rooming
      server; its wire shape is documented in README.md (the implementation
      is server-bound and stays with the site).
   2. Peer — one per remote device: an RTCPeerConnection + a single ordered
      data channel (created by the side with the smaller id, so there is
      never offer glare) + the chunked-transfer engine.
   3. TransferNode — the coordinator: owns the discovery session, the peer
      table, suspended-transfer state and first-contact trust. Presentation
      is a set of optional callbacks (`ui`) — this module never touches the
      DOM or storage, and its only network surface is WebRTC itself.

   Data-channel protocol (string frames are JSON control, binary frames are
   file bytes; the channel is ordered, so chunk order is send order):
     meta {t,id,name,size,mime,r:1,tk?,tt?}   offer one file
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

   File bytes ride the DTLS-encrypted RTCDataChannel, device-to-device —
   discovery relays only the small SDP/ICE handshake. iceServers defaults
   to [] (no STUN/TURN lookups, host candidates only), which confines
   connectivity to the local network; pass STUN/TURN servers to cross NATs. */

/* ---- transfer engine tuning (same values as the in-page build) ---- */
const PREFERRED_CHUNK = 256 * 1024, MIN_CHUNK = 16 * 1024;
const HIGH_WATER = 8 * 1024 * 1024, LOW_WATER = 1 * 1024 * 1024;
const RECV_HIGH = 16 * 1024 * 1024, RECV_LOW = 4 * 1024 * 1024;
/* keep a broken transfer resumable this long — sender holds the File + queue,
   receiver holds its open sink; past it, fail + release */
export const RESUME_GRACE = 5 * 60 * 1000;
/* refuse past ~2GB on the in-memory fallback sink — never silently OOM */
export const MEM_HARD_CAP = 2 * 1024 * 1024 * 1024;

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
export function genCode() { const r = crypto.getRandomValues(new Uint8Array(6)); let s = ''; for (let i = 0; i < 6; i++) s += CODE_ALPHA[r[i] % CODE_ALPHA.length]; return s; }
export function cleanCode(c) { return String(c || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64); }

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
 *    onClose(err)                      — the session died
 *  and accepts:
 *    signal(to, payload)               — relay a payload to one peer
 *    close()                           — leave
 *  Ids are transport-assigned and rotate per (re)connect; the stable device
 *  id rides the name frame instead (see NAME_SEP above).
 * ===================================================================== */

/* Serverless discovery: every tab of one browser is one "LAN". */
export function BroadcastChannelDiscovery(name, code) {
  const self = { onWelcome: null, onPeerJoined: null, onPeerLeft: null, onSignal: null, onClose: null };
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
    }
  };
  setTimeout(() => { self.onWelcome && self.onWelcome(selfId, [], 'local'); bc.postMessage({ d: 'hello', from: selfId, name }); }, 0);
  /* JSON-roundtrip: structured clone (BroadcastChannel) can't clone native
     RTCSessionDescription/RTCIceCandidate, but JSON.stringify invokes their
     toJSON() — matching what a WebSocket transport's send(JSON…) does. */
  self.signal = (to, payload) => bc.postMessage({ d: 'sig', from: selfId, to, payload: JSON.parse(JSON.stringify(payload)) });
  self.close = () => { try { bc.postMessage({ d: 'bye', from: selfId }); bc.close(); } catch {} };
  return self;
}

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
    this.readyResolvers = {}; this.receivedResolvers = {};
    this.chunkSize = PREFERRED_CHUNK; this.sendPaused = false; this._resumeResolve = null;
    this._verified = false;   /* this connection echoed a resume tk — proven to be the original transfer partner, not just a device-id claimant */
  }
  busy() { return !!(this.sending || this.sendQueue.length || this.incoming); }

  _setupPc() {
    if (this.pc) return;
    const gen = this.gen, live = () => gen === this.gen;
    const pc = new RTCPeerConnection({ iceServers: this.app.iceServers });
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
      if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch {} this.app.ui.peerState(this.id, 'failed'); }
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
  }
  _connDead() { return (this.dc && (this.dc.readyState === 'closed' || this.dc.readyState === 'closing')) || (this.pc && (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed')); }

  onSignal(payload) {
    const k = payload && payload.kind;
    if (k === 'please-offer') { if (this.owner) this.ensureChannel(); return; }
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
    const gen = this.gen, live = () => gen === this.gen;
    try { dc.bufferedAmountLowThreshold = LOW_WATER; } catch {}
    dc.onopen = () => { if (!live()) { try { dc.close(); } catch {} return; } this.connected = true; this.app.ui.peerState(this.id, 'connected'); const sctp = this.pc && this.pc.sctp && this.pc.sctp.maxMessageSize; if (sctp) this.chunkSize = Math.max(MIN_CHUNK, Math.min(PREFERRED_CHUNK, sctp)); this.app._resumeInto(this); this._pump(); };   /* clamp chunks to what the remote's SCTP stack accepts */
    dc.onclose = () => { if (!live()) return; this._resetConn(); this._onClosed(); this.app.ui.peerState(this.id, 'failed'); };   /* reset FIRST (null dc/pc, bump gen) so a resume redial can rebuild */
    dc.onmessage = (ev) => { if (live()) this._onMessage(ev.data); };
  }

  _resetConn() { this.gen++; try { this.dc && this.dc.close(); } catch {} try { this.pc && this.pc.close(); } catch {} this.dc = this.pc = null; this.connected = false; this._verified = false; }
  teardown() { this._resetConn(); this._onClosed(); }

  /* ---- send ---- */
  enqueue(files) {
    /* tk: a per-transfer secret that only ever travels the original DTLS-private
       DataChannel. The device id is public (announced in the name frame), so
       resume must NOT trust it alone — a room member could spoof a victim's
       device id and be handed the rest of a suspended file. Both resume
       directions prove knowledge of tk. */
    for (const file of files) { const item = { id: randHex(5), tk: randHex(8), file, sent: 0, status: 'queued', samples: [] }; this.sendQueue.push(item); this.app.ui.addXfer(this.id, this.name, item, 'send'); }
    this.ensureChannel();
    this._pump();
  }
  async _pump() {
    if (this.sending || !this.sendQueue.length) return;
    if (!this.dc || this.dc.readyState !== 'open') return;
    const dc = this.dc, item = this.sendQueue.shift();
    this.sending = item; item.status = 'sending';
    try {
      /* A queued-but-never-offered file resuming alongside verified work must wait for
         this connection to prove itself (an offered sibling's tk echo) — never leak even
         its meta to a device-id spoofer. Checked before anything is sent. */
      if (item._needVerify && !this._verified) { item.status = 'error'; this.app.ui.xferError(this.id, item, 'send'); return; }
      /* r:1 advertises resume; a re-offer after a drop reuses the SAME item id. tk (the
         per-transfer secret) rides ONLY the first offer — the original, DTLS-private
         channel. A re-offer never repeats it: the new connection merely claims the same
         device id, and handing it the secret would let a spoofer "prove" itself. */
      /* First-contact trust rides ONLY a fresh offer. A resumed offer's peer
         hasn't echoed tk yet (a device-id spoofer could be claiming a suspended
         transfer), so granting our token or echoing theirs here would leak it
         to the unverified side — deferred until the tk check below. */
      if (!item._resumed) this.app._grantTrust(this);
      dc.send(JSON.stringify({ t: 'meta', id: item.id, name: item.file.name, size: item.file.size, mime: item.file.type || 'application/octet-stream', r: 1, tk: item._everOffered ? undefined : item.tk, tt: item._resumed ? undefined : this.app._tokFor(this.dev, this.id) }));
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
        await this._stream(dc, item, startOff);
        dc.send(JSON.stringify({ t: 'done', id: item.id }));
        await new Promise((res) => { this.receivedResolvers[item.id] = res; });
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
    finally { this.sending = null; this.app._reap(this); this._pump(); }
  }
  async _stream(dc, item, startOff) {
    const file = item.file, size = file.size; let off = startOff || 0;
    if (off) { item.sent = off; this._sample(item, off); }
    while (off < size) {
      if (item.status === 'canceled' || item.status === 'suspended' || dc.readyState !== 'open') throw new Error('aborted');
      if (dc.bufferedAmount > HIGH_WATER) { await this._wait(dc, 'bufferedamountlow', 1000); continue; }
      if (this.sendPaused) { await this._waitResume(1000); continue; }
      const end = Math.min(off + this.chunkSize, size);
      const buf = await file.slice(off, end).arrayBuffer();
      try { dc.send(buf); } catch { await this._wait(dc, 'bufferedamountlow', 200); if (dc.readyState !== 'open') throw new Error('closed'); dc.send(buf); }
      off = end; item.sent = off; this._sample(item, off);
      const { rate, eta } = this._stats(item, size); this.app.ui.xferProgress(this.id, item, off / size, rate, eta, 'send');
    }
  }
  _wait(dc, ev, ms) { return new Promise((res) => { let done = false; const f = () => { if (done) return; done = true; clearTimeout(t); dc.removeEventListener(ev, f); dc.removeEventListener('close', f); res(); }; const t = setTimeout(f, ms); dc.addEventListener(ev, f); dc.addEventListener('close', f); }); }
  _waitResume(ms) { return new Promise((res) => { const f = () => { clearTimeout(t); if (this._resumeResolve === f) this._resumeResolve = null; res(); }; const t = setTimeout(f, ms); this._resumeResolve = f; }); }

  /* ---- receive (sink chosen by the app's openSink hook) ---- */
  _onMessage(data) { if (typeof data === 'string') this._onControl(data); else this._onChunk(data); }
  _onControl(text) {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (m.t === 'meta') this._onMeta(m);
    else if (m.t === 'ready') { const r = this.readyResolvers[m.id]; if (r) { delete this.readyResolvers[m.id]; r(m); } }
    else if (m.t === 'done') this._finish(m.id);
    else if (m.t === 'received') { const r = this.receivedResolvers[m.id]; if (r) { delete this.receivedResolvers[m.id]; r(); } }
    else if (m.t === 'awaiting') { if (this.sending && this.sending.id === m.id) this.app.ui.xferAwait(this.id, this.sending); }   /* receiver is showing its first-contact accept prompt */
    else if (m.t === 'trust') { this.app._takeTok(this.dev, this.id, m.tok); }   /* this device granted us first-contact trust — echo the token on future offers (_takeTok validates the shape) */
    else if (m.t === 'pause') { if (this.sending && this.sending.id === m.id) this.sendPaused = true; }
    else if (m.t === 'resume') { if (this.sending && this.sending.id === m.id) { this.sendPaused = false; if (this._resumeResolve) this._resumeResolve(); } }
    else if (m.t === 'cancel') this._remoteCancel(m.id);
  }
  _onMeta(m) {
    if (this.incoming) this._abort(this.incoming);   /* a new offer supersedes an unfinished one (frees a stale accept prompt / waiting sender) */
    const claimed = this.app._claimRecv(this.dev, m);
    if (claimed) { this.app._grantTrust(this); this._resume(claimed); return; }   /* the sender re-offered a receive we suspended on a drop — pick up at the settled offset, same sink; a resumable receive was accepted once already */
    const jd = this.app._justDone(this.dev, m.id);
    if (jd) { this.app._grantTrust(this); this._safe({ t: 'ready', id: m.id, off: Number(m.size) || 0, tk: jd.tk }); return; }   /* we finished this one but our receipt was lost in the drop — don't receive it twice */
    const size = Number(m.size);
    const rec = { id: m.id, name: m.name || 'file', size: Number.isFinite(size) && size >= 0 ? size : 0, mime: m.mime || 'application/octet-stream', tk: (typeof m.tk === 'string' && m.tk.length >= 8 && m.tk.length <= 32) ? m.tk : '', _tt: /^[0-9a-f]{24}$/.test(m.tt || '') ? m.tt : '', received: 0, inFlight: 0, recvPaused: false, samples: [], chain: Promise.resolve(), sink: null, _cancelPrompt: null };
    this.incoming = rec;
    this.app.ui.addXfer(this.id, this.name, rec, 'recv');
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
        this._safe({ t: 'awaiting', id: rec.id });   /* older peers ignore unknown control frames */
        await this.app.ui.promptAccept(this.id, rec);
        if (this.incoming !== rec) return;   /* superseded while the prompt was up */
        this.app._grantTrust(this);
      }
      rec.sink = await this.app.openSink(this, rec);   /* may await a user gesture (e.g. a save picker) */
      if (!rec.sink) throw new Error('too-large');     /* the sink provider refused (e.g. over the in-memory cap) */
      if (this.incoming !== rec) { try { await rec.sink.abort(); } catch {} return; }   /* superseded/canceled while awaiting a gesture */
      this._safe({ t: 'ready', id: rec.id });
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
    const rec = this.incoming; if (!rec || !rec.sink) return;
    rec.received += buf.byteLength;
    if (rec.received > rec.size) { this._abort(rec); return; }   /* lying sender guard */
    rec.inFlight += buf.byteLength;
    rec.chain = rec.chain.then(() => rec.sink.write(buf)).then(() => {
      rec.inFlight -= buf.byteLength;
      if (rec.recvPaused && rec.inFlight <= RECV_LOW) { rec.recvPaused = false; this._safe({ t: 'resume', id: rec.id }); }
    }, () => { this._abort(rec); });
    if (!rec.recvPaused && rec.inFlight >= RECV_HIGH) { rec.recvPaused = true; this._safe({ t: 'pause', id: rec.id }); }   /* disk slower than the wire — hold the sender */
    this._sample(rec, rec.received);
    const { rate, eta } = this._stats(rec, rec.size);
    this.app.ui.xferProgress(this.id, rec, rec.size ? rec.received / rec.size : 0, rate, eta, 'recv');
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
    finally { this.app._reap(this); }
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
  }
  _remoteCancel(id) {
    if (this.incoming && this.incoming.id === id) { const rec = this.incoming; rec._ended = true; if (rec._cancelPrompt) rec._cancelPrompt(); this._teardownSink(rec); this.app.ui.xferError(this.id, rec, 'recv'); this.incoming = null; }
    if (this.sending && this.sending.id === id) { this.sending.status = 'canceled'; this.sendPaused = false; if (this._resumeResolve) this._resumeResolve(); this.app.ui.xferError(this.id, this.sending, 'send'); }
    const rr = this.readyResolvers[id]; if (rr) { delete this.readyResolvers[id]; rr(); }
    const cr = this.receivedResolvers[id]; if (cr) { delete this.receivedResolvers[id]; cr(); }
    this.app._reap(this);
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
  }
  _safe(o) { if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(JSON.stringify(o)); } catch {} } }
  _sample(item, bytes) { const now = performance.now(); item.samples.push([now, bytes]); while (item.samples.length > 2 && now - item.samples[0][0] > 2000) item.samples.shift(); }
  _stats(item, total) { const s = item.samples; if (s.length < 2) return { rate: 0, eta: NaN }; const dt = (s[s.length - 1][0] - s[0][0]) / 1000; const db = s[s.length - 1][1] - s[0][1]; const rate = dt > 0 ? db / dt : 0; const done = item.sent != null ? item.sent : (item.received || 0); return { rate, eta: rate > 0 ? Math.max(0, total - done) / rate : NaN }; }
}

/* ===================================================================== *
 *  3. TRANSFER NODE — one endpoint: discovery session + peer table +
 *     resume state + first-contact trust.
 *
 *  new TransferNode({
 *    name,        // display name announced to peers (default: deviceLabel())
 *    dev,         // stable device id ([a-z0-9]{8,16}) — resume identity across
 *                 // reconnects; default random per instance
 *    code,        // optional room code (namespaces the discovery channel)
 *    discovery,   // (framedName, code) => discovery session
 *                 // (default: BroadcastChannelDiscovery)
 *    iceServers,  // RTCPeerConnection iceServers (default [] = LAN only)
 *    openSink,    // async (peer, rec) => sink | null — where a receive lands
 *                 // (default: MemSink, refusing past memCap)
 *    memCap,      // default sink's refusal cap (default MEM_HARD_CAP)
 *    ui,          // presentation callbacks, all optional:
 *      setStatus(state)                    'searching'|'ready'|'offline'|'off'
 *      renderRoster(rosterMap)             the device list changed
 *      peerState(id, state)                'connecting'|'connected'|'failed'
 *      addXfer(peerId, peerName, item, dir)          a transfer row appeared
 *      xferProgress(peerId, item, frac, rate, eta, dir)
 *      xferDone(peerId, item, dir) / xferError(peerId, item, dir)
 *      xferSuspend(peerId, item, dir)      parked after a drop, resumable
 *      rekeyXfer(oldId, newId, item, dir)  a parked transfer resumed under a
 *                                          new connection id
 *      xferAwait(peerId, item)             receiver is at its accept prompt
 *      promptAccept(peerId, rec) → Promise reject(Error('declined')) to refuse;
 *                                          may set rec._cancelPrompt to be torn
 *                                          down if the offer dies meanwhile
 *      downloadBlob(blob, name)            a default-sink (in-memory) receive
 *                                          finished — hand the file over
 *  })
 * ===================================================================== */

export class TransferNode {
  constructor(opts) {
    opts = opts || {};
    this.name = String(opts.name || deviceLabel());
    this.dev = devOk(opts.dev) ? opts.dev : randHex(5);
    this.code = opts.code ? cleanCode(opts.code) : '';
    this.iceServers = Array.isArray(opts.iceServers) ? opts.iceServers : [];
    this.makeDiscovery = typeof opts.discovery === 'function' ? opts.discovery : BroadcastChannelDiscovery;
    this.memCap = (Number.isFinite(opts.memCap) && opts.memCap > 0) ? opts.memCap : MEM_HARD_CAP;
    this.openSink = opts.openSink || (async (peer, rec) => (rec.size > this.memCap ? null : new MemSink(rec.name, rec.mime, (blob, name) => this.ui.downloadBlob(blob, name))));
    this.ui = Object.assign({
      setStatus() {}, renderRoster() {}, peerState() {},
      addXfer() {}, xferProgress() {}, xferDone() {}, xferError() {},
      xferSuspend() {}, xferAwait() {}, rekeyXfer() {}, downloadBlob() {},
      promptAccept() { return Promise.resolve(); },
    }, opts.ui || {});
    this.selfId = null; this.room = null; this.discovery = null;
    this.peers = new Map(); this.roster = new Map();
    this._susp = new Map(); this._doneRecent = new Map();
  }

  /* The name announced through discovery: display name framed with the stable
     device id (see NAME_SEP above). */
  announceName() {
    const base = String(this.name || 'device').split(NAME_SEP).join('').slice(0, 40);   /* strip any US so a name can't corrupt the framing */
    return base + NAME_SEP + NAME_SEP + NAME_SEP + this.dev;
  }

  /* Open the discovery session (one per node). Callbacks from a session we've
     already moved past are ignored: a queued welcome/peer/signal from an old
     transport must not clobber a newer session. (The Peer class guards its
     channel callbacks the same way.) Discovery dying does NOT touch live
     peers — file bytes run peer-to-peer and don't need the session once a
     channel is open; call join() again to rejoin (the in-page build layers
     auto-reconnect with backoff on top of exactly this). */
  join() {
    if (this.discovery) return this;
    const d = this.discovery = this.makeDiscovery(this.announceName(), this.code);
    const live = () => this.discovery === d;
    this.ui.setStatus('searching');
    d.onWelcome = (selfId, peers, room) => { if (!live()) return; this.selfId = selfId; this.room = room || null; this._clearRoster(); (peers || []).forEach((p) => { if (p.id !== selfId) this._rosterAdd(p); }); this._reconcile(); this.ui.renderRoster(this.roster); this.ui.setStatus('ready'); };
    d.onPeerJoined = (p) => { if (!live() || !p || p.id === this.selfId) return; this._rosterAdd(p); this.ui.renderRoster(this.roster); };
    d.onPeerLeft = (id) => { if (!live()) return; this._rosterLeft(id); this.ui.renderRoster(this.roster); };
    d.onSignal = (from, payload) => { if (!live()) return; this._peer(from).onSignal(payload); };
    d.onClose = () => { if (!live()) return; this.discovery = null; this.selfId = null; this.ui.setStatus('offline'); };
    return this;
  }

  /* Leave discovery and tear everything down. Teardowns park in-flight work
     first (they may hold open sinks / File handles), so the suspended set is
     expired AFTER them — closing a node must abort every held sink, never
     leave one waiting on a resume that can't come. */
  close() {
    const d = this.discovery;
    this.discovery = null; this.selfId = null;
    try { d && d.close(); } catch {}
    for (const [id, p] of [...this.peers]) { try { p.teardown(); } catch {} this.peers.delete(id); }
    this.roster.clear();
    this._expireAllSuspended();
    this.ui.renderRoster(this.roster);
    this.ui.setStatus('off');
  }

  /* ---- roster ---- */
  _clearRoster() { this.roster.clear(); }
  /* After a welcome repaints the roster: any Peer whose row did NOT come back
     left while we were away (its peer-left never reached us). Busy live
     channel → orphan (finish, then reap); otherwise tear down now — else the
     Peer object idles in `peers` forever. */
  _reconcile() {
    for (const [id, pe] of [...this.peers]) {
      if (this.roster.has(id)) continue;
      if (pe.connected && pe.busy()) { pe.orphaned = true; continue; }
      pe.teardown(); this.peers.delete(id);
    }
  }
  _rosterAdd(p) {
    if (!p || !p.id) return;
    const m = parsePeerName(p.name);
    if (m.dev && m.dev === this.dev) return;   /* our own stale connection echoed back by the transport (ids rotate per connect) — never roster yourself */
    this.roster.set(p.id, { id: p.id, name: m.name, dev: m.dev });
    const pe = this.peers.get(p.id);
    if (pe) {
      pe.orphaned = false; pe.name = m.name;   /* row is back — cancel any pending drain-reap */
      if (m.dev && !pe.dev) { pe.dev = m.dev; this._migrateTrust(p.id, m.dev); if (!pe.dc && m.dev !== this.dev) pe.owner = this.dev < m.dev; }   /* Peer was built from a signal that beat the roster (dev unknown → legacy owner); now that dev is known, re-derive ownership BEFORE any channel exists, or the two ends disagree on who offers (double-channel glare / neither offers), and move any conn-id-keyed trust to the stable dev key */
      else if (m.dev) pe.dev = m.dev;
    }
    if (m.dev && this._susp.has(m.dev)) queueMicrotask(() => { if (this._susp.has(m.dev) && this.roster.has(p.id)) this._peer(p.id).ensureChannel(); });   /* the device we hold suspended transfers for is back (maybe under a fresh id) → redial so resume can run */
  }
  _rosterLeft(id) {
    this.roster.delete(id);
    const pe = this.peers.get(id); if (!pe) return;
    if (pe.connected && pe.busy()) { pe.orphaned = true; return; }   /* the discovery session flapped, but the DataChannel is P2P and still moving bytes — let the transfer finish; reaped on drain */
    pe.teardown(); this.peers.delete(id);
    if (!pe.dev) this._forgetPeerTok(id);   /* a conn-id-keyed trust with no stable dev can never be re-matched — drop it so p: entries don't accumulate (dev-keyed trust survives a reconnect and stays) */
  }

  /* ---- signalling + peers ---- */
  signal(to, payload) { if (this.discovery) this.discovery.signal(to, payload); }
  _peer(id) {
    let p = this.peers.get(id);
    if (!p) {
      const info = this.roster.get(id) || { name: 'device' };
      p = new Peer(this, id, info.name);
      p.dev = info.dev || '';
      /* glare avoidance: when both ends advertise a stable device id, ownership
         compares those (stable across discovery reconnects — no owner flip
         mid-session). Legacy fallback compares our transport selfId with the
         peer's connection id, as before. */
      p.owner = (p.dev && p.dev !== this.dev) ? (this.dev < p.dev) : (String(this.selfId || '') < id);
      this.peers.set(id, p);
    }
    return p;
  }
  /* Queue files to a rostered device (File objects, or Blobs carrying a
     `name`). Bytes flow once the channel opens. */
  sendTo(id, files) {
    if (!files || !files.length) return;
    /* Don't build a Peer while discovery has no selfId (e.g. a roster tile
       lingering during a rejoin): glare would resolve ownership from '' < id,
       open a data channel, and route the offer to a dead session — a
       permanently stuck send. */
    if (!(this.discovery && this.selfId)) return;
    /* trust is granted from _pump once the channel is open (the grant frame
       needs the DTLS channel) — you chose to send TO this device, so its
       transfers back need no first-contact confirm */
    this._peer(id).enqueue(files);
  }

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
     late reconnect re-receive a completed file) — with its tk, so the re-ack carries proof. */
  _markDone(dev, id, tk) { if (!dev) return; const now = Date.now(); for (const [k, e] of this._doneRecent) { if (now - e.t > RESUME_GRACE) this._doneRecent.delete(k); } this._doneRecent.set(dev + ':' + id, { t: now, tk: tk || '' }); }
  _justDone(dev, id) { if (!dev) return null; const k = dev + ':' + id, e = this._doneRecent.get(k); if (!e) return null; if (Date.now() - e.t > RESUME_GRACE) { this._doneRecent.delete(k); return null; } return e; }
  /* An orphaned peer (roster row gone, kept only for its in-flight transfer) is torn
     down once it drains. Reset `orphaned` first — teardown re-enters here via _onClosed. */
  _reap(peer) {
    if (!peer.orphaned || peer.busy()) return;
    peer.orphaned = false;
    peer.teardown();
    if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id);
  }

  /* ---- first-contact trust: the FIRST file from a device must be accepted
     (ui.promptAccept); a device you've exchanged files with — you sent to it,
     or you accepted from it — flows without asking. In-memory only: a fresh
     node starts over, which is the safe default.

     The device id rides the public name frame, so it must never BE the trust
     proof (a room member could claim a trusted device's id). Granting trust
     mints a per-device secret token and hands it to the peer over the
     DTLS-private channel ({t:'trust'}); skipping the prompt later requires
     the meta frame to echo that token (`tt`). The public dev id is only the
     lookup key. Same pattern as the per-transfer resume tk. */
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
    p._safe({ t: 'trust', tok });
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
