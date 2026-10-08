# Transfer

Send files device-to-device over a direct WebRTC data channel — discovery
hands the devices to each other, then the bytes never touch a server. This is
the engine of the [Transfer tool on subnsub.com](https://subnsub.com)
(`/transfer`), published so the "your files go straight to the other device"
claim is auditable: the chunked-transfer engine, backpressure, resume, trust,
fallback and multipath logic here are kept in lockstep with the in-page
version.

## Files

- [`transfer.js`](transfer.js) — the module: `TransferNode`,
  `BroadcastChannelDiscovery`, `PipeChannel`, sinks (`FSASink`, `MemSink`,
  `fileWritableInDir`, `supportsFSA`), helpers (`deviceLabel`, `genCode`,
  `cleanCode`, `codeComplete`, `pairLinkCode`), multipath framing (`mpFrame`,
  `mpTake`, `mpTagOf`, `MP_HDR`), constants (`RESUME_GRACE`, `MEM_HARD_CAP`,
  `FALLBACK_MS`, `CODE_LEN`, `PIPE`, `PIPE_ID_LEN`, `PIPE_HDR`)
- [`demo.html`](demo.html) — minimal standalone page: open it in **two tabs
  of one browser** and send a file between them. Discovery runs over a
  BroadcastChannel, so the whole flow works with no server at all.

## Usage

```js
import { TransferNode, deviceLabel } from './transfer.js';

const node = new TransferNode({
  name: deviceLabel(),        // announced to peers
  // iceServers: [],          // default: no STUN/TURN — local network only
  // relayIceServers: [...],  // TURN entries for the fallback's relay leg (see below)
  // link: {...}, tunnel: {...}, // the other two injectable legs (see below)
  ui: {
    renderRoster(roster) {},  // Map<id, {id, name, dev, tag}> — the device list
    addXfer(peerId, peerName, item, dir) {},          // a transfer appeared
    xferProgress(peerId, item, frac, rate, eta, dir) {},
    xferDone(peerId, item, dir) {},
    xferError(peerId, item, dir) {},
    promptAccept: (peerId, rec) => Promise.resolve(), // first-contact gate
    downloadBlob(blob, name) {},                      // finished in-memory receive
  },
});
node.join();                  // open your own room (mode 'on')
node.dial(code);              // also enter another device's room by its code
node.sendTo(peerId, files);   // peerId from the roster; files = File objects
node.close();                 // leave everything + abort everything held
```

Every `ui` callback is optional (see the block comment above `TransferNode`
for the full contract). Where an incoming file lands is the `openSink`
option: an async `(peer, rec) → sink` returning any object with
`write(buf)` / `close()` / `abort()`. The default assembles the file in
memory (refusing past `MEM_HARD_CAP`, ~2 GB) and hands the finished Blob to
`ui.downloadBlob`; on desktop Chromium you can stream to disk instead —
`FSASink` wraps a File System Access writable, and `fileWritableInDir`
picks a collision-free name inside a chosen directory handle.

One deliberate storage note: writing a received file to where you point it
**is the tool** — that File System Access sink is the only thing here that
touches disk, it only ever runs inside your explicit directory pick, and
the module keeps no state of its own (no localStorage, no IndexedDB; even
trust tokens and relay credentials are in-memory only).

## Visibility: on, out only, off

A node has one visibility `mode`, and being findable is separate from being
able to reach out:

| mode | what is open | who can find you |
| --- | --- | --- |
| `'on'` (`join()` / `setMode('on')`) | your own room (`code`) + every room you dial | anyone holding your code |
| `'dial'` — out only (`setMode('dial')`, or `dial(code)` from a cold stop) | only the rooms you dial | nobody by code — but the device you dial sees you inside *its* room, and the channel it opens is two-way |
| `'off'` (`close()` / `setMode('off')`) | nothing | nobody |

`dial(code)` opens a separate discovery session per dialled code beside your
own (`hangUp(code)` leaves one). Dropping to out only closes your own room but
keeps parked (resumable) transfers — the only way a parked peer can come
back is through a room you yourself dial. Going off is an explicit stop and
releases every held sink and File. The hosted build persists the mode and
rotates its code on every leave of `'on'`; that is its own policy, not the
engine's.

## Pairing codes

`genCode()` mints a 6-character code from an unambiguous alphabet;
`cleanCode()` normalises anything typed or pasted to the code grammar
(`[a-z0-9_-]{1,64}`). **The sixth character connects**: a typed code needs
no confirm step — `codeComplete(input)` returns the cleaned code the moment
exactly `CODE_LEN` (6) clean characters are in hand, and `''` before that.
Longer codes only ever arrive whole, as pair links: `pairLinkCode(text)`
reads the `#c=<code>` fragment (6–64 chars) out of a pasted link, and is
checked *before* anything is typed into the entry — otherwise a link's first
six letters would dial a room. The hosted build's input cells, IME guards and
clipboard handling sit on top of these two helpers.

## Discovery contract

`TransferNode` talks to each discovery session through this contract:

```
onWelcome(selfId, peers[], room)   you're in — your transport id + roster
onPeerJoined({id, name})           someone arrived
onPeerLeft(id)                     someone left
onSignal(from, payload)            a targeted signal relayed to you
onPipe(from, buf)                  a binary pipe frame relayed to you (optional)
onClose(err)                       the session died
signal(to, payload)                relay a payload to one peer
pipe(to, frame) → bool             relay a binary frame to one peer (optional)
close()                            leave
```

`BroadcastChannelDiscovery` (included) implements all of it across the tabs
of one browser — zero server, which is also what makes the demo
self-contained.

The production tool implements the same contract over a WebSocket to a
small rooming server whose jobs are grouping clients into rooms, relaying
targeted signals, and — for the relay-pipe leg — forwarding binary pipe
frames between two members of a room. A pipe frame is
`[PIPE_ID_LEN bytes peer id][1 byte kind][4 bytes session id][payload]`:
the sender writes the *target* id into the id slot, the relay swaps in the
*sender's* id and forwards, nothing else. Everything past the header is
ciphertext the relay cannot read (see below). The hosted relay additionally
keeps **per-peer consent**: it forwards bulk (`DATA`/`TEXT`) frames only
between a pair that completed `OPEN` → `ACK_OPEN` → `COMMIT` through it,
tracks exact frame lengths, and budgets handshake and bulk traffic per
socket and per room — a relay that does not carry binary frames at all is
fine too, the knock simply times out and the other legs carry on. Any
transport that can deliver these callbacks satisfies the module;
`BroadcastChannelDiscovery` is the reference implementation to copy from.

Transport ids are `PIPE_ID_LEN` (8) characters and rotate on every
(re)connect. A stable per-device id therefore rides the announced name
(`announceName()` frames it, `parsePeerName()` reads it back) — that id
keys resume state and channel ownership across reconnects.

## Data-channel protocol

One ordered `RTCDataChannel` ("files") per peer pair, created by the side
with the smaller id so there is never offer glare. String frames are JSON
control; binary frames are file bytes (256 KiB chunks, never above the
remote's SCTP `maxMessageSize` — that negotiated ceiling always wins, even
if the peer advertises under 16 KiB):

| frame | meaning |
| --- | --- |
| `caps {mp:1}` | sent the moment a channel opens: "I read offset-framed data" (`mp` is a format version, not a flag) |
| `meta {id,name,size,mime,r:1,mp?,tk?,tt?}` | offer one file; `mp:1` = this file's frames carry offsets |
| `ready {id,off?,tk?}` | receiver's go — `off` = resume offset |
| `awaiting {id}` | receiver is at its first-contact accept gate |
| `trust {tok}` | trust token grant (see below) |
| `pause {id}` / `resume {id}` | receive-side backpressure |
| `done {id}` / `received {id}` | sender's EOF / receiver's receipt |
| `cancel {id}` | either side aborts |

Senders throttle on `bufferedAmount` (8 MB high / 1 MB low water); receivers
additionally hold the sender with `pause`/`resume` while their sink's
un-settled writes exceed 16 MB — for disks slower than the wire.

## Resume and trust

- A dropped connection **parks** in-flight work instead of failing it: the
  sender keeps its File handles + queue, the receiver keeps its open sink,
  for `RESUME_GRACE` (5 min). When the same device reconnects, files are
  re-offered under their original ids and the receiver answers
  `ready{off}`, so streams pick up mid-file.
- The public device id is never proof of identity — any room member could
  claim it. Each transfer carries a secret (`tk`) that only ever travelled
  the original DTLS-private channel; each resume direction must echo it
  before a byte moves.
- The **first** file from a device you've never exchanged files with goes
  through an accept gate (`ui.promptAccept`; the sender sees `awaiting`).
  Acceptance mints a per-device trust token, handed over in-channel
  (`trust`) and echoed on later offers (`tt`) to skip the gate. A
  link-delivered file has no channel, so `awaiting` and `trust` travel
  signalling for it as `{kind:'ctl', m}`. Trust is in-memory only — a fresh
  node starts over.
- File bytes ride the DTLS-encrypted data channel, device-to-device.
  Discovery relays only the handshake (and, on the pipe leg, ciphertext).

## No direct route: the fallback race

The first attempt is always STUN-only (`iceServers`): a relay pair must
never be picked while a direct one would do. Once direct is judged dead —
`connectionState` `failed`, or `FALLBACK_MS` (15 s) with no channel after a
send was queued — every leg starts at the same instant and the first to come
up carries the file. Only the side with something to send drives the race;
the receiver mirrors it (adopts a shared credential, answers the knock, the
hello and the link offer). The verdict turns terminal (`ui.peerState`
`'failed'`) only once every leg is dead.

| leg | needs | how it wins |
| --- | --- | --- |
| **turn** | `relayIceServers` | the TURN entries are fetched *now* (never up front — a minted credential may be a scarce allowance), handed to the peer over signalling as `{kind:'turn', iceServers, expiresAt}` so a pair that can only mint on one side still relays on both, and ICE is restarted with them (`please-restart` asks the owner to re-offer when the answerer adopted). Dead after `TURN_LEG_MS` (30 s) without a channel. |
| **pipe** | a discovery session with `pipe()` | the relay pipe below knocks; wins when the far end acks and we commit |
| **tun** | `tunnel` | the tunnel leg below |
| **r2** (link) | `link` | per file within `link.maxBytes`: AES-256-GCM-encrypt, `put` it, hand URL + key + iv to the peer as `{kind:'r2'}`; the peer `get`s, decrypts, and answers `r2-received` / `r2-failed`. An upload that finishes before a transport started that file takes it out of the queue; a transport that picks the file first aborts its upload. No receipt within 10 min, or a failed download, puts the file back for a transport and re-runs the race. A channel offer of a file still coming down as a link supersedes the download. |

`relayIceServers` is either an `RTCIceServer[]` or an async function
returning one (or `{iceServers, expiresAt}`); the result is cached until
`expiresAt` (default 1 h). A credential the **peer** hands over is vetted by
`acceptRelayServers(list) → list | null` (default: refuse), lives in its own
slot, never replaces or blocks your own, and is held at most 4 h — a hostile
room member can at worst hand you a relay that doesn't work. The hosted
build pins shared credentials to its own relay host and gates relayed
transfers with a per-file cap and a daily allowance; that policy stays with
the site.

`link` is `{ maxBytes, put(blob, {signal}) → Promise<string>, get(url,
{signal}) → Promise<Response | ReadableStream | Blob | ArrayBuffer> }`. The
store sees only ciphertext (the key never leaves signalling); validating the
URL it is asked to `get` is the store's job. A receiver with no store, or
whose cap the file exceeds, answers `r2-failed` at once.

### The relay pipe (`PipeChannel`)

An `RTCDataChannel` look-alike over the discovery session's `pipe()` (or a
tunnel wire): `send` / `bufferedAmount` / `bufferedamountlow` / `onmessage` /
`close`, so meta, chunks, pause/resume and mid-file resume run over it
unchanged. Frame kinds: `OPEN`(1) `ACK_OPEN`(2) `COMMIT`(3) `DATA`(4)
`TEXT`(5) `ACK`(6) `CLOSE`(7).

- **Handshake**: initiator knocks (`OPEN` with its ephemeral ECDH P-256
  public key, retried every 1.5 s for 8 s) → responder derives, answers
  `ACK_OPEN` with its key and keeps its WebRTC attempt alive → initiator
  decides: a channel that opened meanwhile wins (`CLOSE`, unless the pair
  races — then the pipe joins as a lane) or `COMMIT`s → both bind the pipe.
- **Sealed**: every frame carries a 4-byte session id, so a stale or
  replayed frame from an earlier knock can't touch a newer pipe; a fresh
  knock replaces a stale pair on both ends; every exit (fail, abandon, lost,
  close) says `CLOSE` for its session. `DATA`/`TEXT` payloads are
  `[8-byte counter][AES-256-GCM ciphertext]` with the frame kind + session
  id as additional authenticated data; the receiver accepts only the exact
  next counter — no gaps, repeats or reordering — so a node in the middle
  cannot drop-and-replay an equal-length chunk into a file that then
  reports success.
- **Flow control** is the pipe's own: every bulk frame is acked with its
  byte count, at most 4 MB are unacked in flight, the rest queues and counts
  toward `bufferedAmount`; 20 s without an ack = the pipe is dead.

### The tunnel leg (`tunnel` provider)

A machine that one side can already reach through an end-to-end encrypted
tunnel couples the two browsers' byte streams; only one side needs such a
machine. The **host** is the side with a machine (both have one: the side
driving the race, between two drivers the channel owner); the **guest**
makes an ephemeral key, learns the offer over signalling and dials in. Over
the two streams ride exactly the relay pipe's frames (`PipeChannel` over a
length-prefixed wire: `[4 bytes LE length][frame]`, length 0 = keepalive
every 45 s), so the machine forwards ciphertext it cannot read and a guest
can reach nothing but the one peer that invited it. Signalling:
`{kind:'tun', t:'hello', ask, host, key}` each way settles the roles, then
`offer {sid, offer}` from the host, `ready {sid}` from a non-knocking guest,
`fail {why}` from either. The provider contract:

```
tunnel.canHost() → bool                    this node has a machine it may dial as itself
tunnel.keygen() → {publicKey, privateKey}  an ephemeral guest key (may be async)
tunnel.isKey(pub) → bool                   vet a peer's public key (optional)
tunnel.isOffer(offer) → bool               vet a host's offer object (optional)
tunnel.host(sid, peerPublicKey, io)        dial your machine, invite the guest's key for
  → Promise<{offer, write, end, cancel, close}>   session sid, open the streams
tunnel.guest(sid, offer, key, io)          dial the machine named in offer with key
  → Promise<{write, end, cancel, close}>
io = { onData(chunk: Uint8Array), onClose(why) }   bytes from the far end / stream gone
write(Uint8Array) → Promise                one write at a time; end() closes the send
                                           side cleanly, cancel() cuts both
```

`sid` is 24 hex chars minted by the host; the offer object is opaque to the
engine (the hosted build's carries the machine's address and a relay map).
Everything about the machine — its tunnel library, key enrolment,
one-node-per-key locking, leases — belongs to the provider. The hosted
build's provider is the Monitor helper's direct mode.

## The multipath race

Every road that comes up is **kept** beside the WebRTC channel rather than
torn down for losing the sprint to connect, and the pipe and tunnel roads go
up as soon as two devices are paired — not when a file is queued. A file is
then streamed down all of them at once:

- `this.dc` stays *the* channel: every control frame travels it alone, so
  the protocol above is unchanged and a road that dies mid-file still
  suspends and resumes the way one always did.
- Nothing is raced until the far end answers `caps {mp:1}`; an older build
  gets exactly the single-channel protocol, and lanes it never acknowledges
  are let go after 8 s.
- A raced file is offered with `meta.mp:1` and its data frames are
  `[8 bytes offset LE][4 bytes file tag LE][payload]` (`mpFrame`). Every road
  carries the whole file from the same start offset; the receiver keeps one
  sink and a high-water mark and writes only what is past it (`mpTake`): a
  slower road's copy is dropped, a frame that straddles the mark is trimmed,
  and the tag (derived from the item id, never sent) stops the last frame of
  a finished file from being trimmed into the next one.
- No `done` rides a raced send (an empty file aside): it would overtake the
  road actually carrying the bytes and fail the receive as truncated. A
  raced receive finishes on its own mark, and its `received` is what ends
  the send; the roads still mid-file are cut where they stand.
- The price, accepted deliberately: a file leaves the device once per road.

`ui.peerRoads(id, {list, tun, mp})` reports which roads carry a pair
(`'rtc'|'turn'|'pipe'|'tunnel'`), the tunnel leg's state
(`'live'|'dialling'|'idle'|'none'|'off'|'fail'`) and whether the pair races
at all; `ui.xferVia` names the road a transfer rides
(`'rtc'|'turn'|'pipe'|'tunnel'|'race'|'link'`).

## What the hosted build adds (not in this module)

- **STUN/TURN policy.** `iceServers` defaults to `[]` — host candidates
  only, so connectivity is confined to the local network. The hosted build
  injects its STUN configuration, mints short-lived TURN credentials
  through its own endpoint and pins peer-shared credentials to its relay
  host. How much relayed traffic it allows is the server's policy, not
  this module's.
- The WebSocket discovery implementation, with reconnect/backoff, a base
  rotation when a signalling host black-holes, and an account room that
  lets signed-in devices meet without a code.
- The relay side of the pipe leg (per-peer consent, budgets), the upload
  store behind the link leg, and the Monitor helper behind the tunnel leg.
- Persisted visibility mode and code rotation, a strict LAN-only mode,
  offline (QR) pairing, more receive destinations, and the whole device-grid
  UI including the six-cell code entry.
