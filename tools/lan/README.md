# LAN File Transfer

Send files device-to-device over a direct WebRTC data channel — discovery
hands the devices to each other, then the bytes never touch a server. This is
the core engine of the [Transfer tool on subnsub.com](https://subnsub.com)
(`/lan`), published so the "your files go straight to the other device"
claim is auditable: the chunked-transfer engine, backpressure, resume and
trust logic here are kept in lockstep with the in-page version.

## Files

- [`lan-transfer.js`](lan-transfer.js) — the module: `TransferNode`,
  `BroadcastChannelDiscovery`, sinks (`FSASink`, `MemSink`,
  `fileWritableInDir`, `supportsFSA`), helpers (`deviceLabel`, `genCode`,
  `cleanCode`), constants (`RESUME_GRACE`, `MEM_HARD_CAP`)
- [`demo.html`](demo.html) — minimal standalone page: open it in **two tabs
  of one browser** and send a file between them. Discovery runs over a
  BroadcastChannel, so the whole flow works with no server at all.

## Usage

```js
import { TransferNode, deviceLabel } from './lan-transfer.js';

const node = new TransferNode({
  name: deviceLabel(),        // announced to peers
  // iceServers: [],          // default: no STUN/TURN — local network only
  ui: {
    renderRoster(roster) {},  // Map<id, {id, name, dev}> — the device list
    addXfer(peerId, peerName, item, dir) {},          // a transfer appeared
    xferProgress(peerId, item, frac, rate, eta, dir) {},
    xferDone(peerId, item, dir) {},
    xferError(peerId, item, dir) {},
    promptAccept: (peerId, rec) => Promise.resolve(), // first-contact gate
    downloadBlob(blob, name) {},                      // finished in-memory receive
  },
});
node.join();                  // open discovery (BroadcastChannel by default)
node.sendTo(peerId, files);   // peerId from the roster; files = File objects
node.close();                 // leave + abort everything held
```

Every `ui` callback is optional (see the block comment above `TransferNode`
for the full contract). Where an incoming file lands is the `openSink`
option: an async `(peer, rec) → sink` returning any object with
`write(buf)` / `close()` / `abort()`. The default assembles the file in
memory (refusing past `MEM_HARD_CAP`, ~2 GB) and hands the finished Blob to
`ui.downloadBlob`; on desktop Chromium you can stream to disk instead —
`FSASink` wraps a File System Access writable, and `fileWritableInDir`
picks a collision-free name inside a chosen directory handle.

## Discovery contract

`TransferNode` talks to discovery through a five-callback session:

```
onWelcome(selfId, peers[], room)   you're in — your transport id + roster
onPeerJoined({id, name})           someone arrived
onPeerLeft(id)                     someone left
onSignal(from, payload)            a targeted signal relayed to you
onClose(err)                       the session died
signal(to, payload)                relay a payload to one peer
close()                            leave
```

`BroadcastChannelDiscovery` (included) implements it across the tabs of one
browser — zero server, which is also what makes the demo self-contained.

The production tool implements the same contract over a WebSocket to a small
rooming server, whose only jobs are grouping clients into rooms and relaying
targeted signals (it never sees file bytes — only SDP/ICE handshakes). Its
wire shape, if you want to run your own:

- Join `wss://<base>/room/<code>?name=<announced name>` for a shared-code
  room, or `wss://<base>/discover?name=…` for a room derived server-side
  from the caller's public IP (that is the "devices on the same network see
  each other" mode). Room codes match `[a-z0-9_-]{6,64}` (`genCode()` uses
  an unambiguous subset); announced names are capped server-side (160).
- Server → client: `{type:'welcome', selfId, peers:[{id,name}], room}`,
  then `{type:'peer-joined', peer:{id,name}}`, `{type:'peer-left', id}`,
  and `{type:'signal', from, payload}`.
- Client → server: `{t:'signal', to, payload}`.

Transport ids rotate on every (re)connect. A stable per-device id therefore
rides the announced name (US-delimited 4th segment) — it keys resume state
and channel ownership; the two middle segments are reserved (the in-page
build carries tile accent colours there).

## Data-channel protocol

One ordered `RTCDataChannel` ("files") per peer pair, created by the side
with the smaller id so there is never offer glare. String frames are JSON
control; binary frames are file bytes (256 KiB chunks, clamped to the
remote's SCTP `maxMessageSize`, never below 16 KiB):

| frame | meaning |
| --- | --- |
| `meta {id,name,size,mime,r:1,tk?,tt?}` | offer one file |
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
  (`trust`) and echoed on later offers (`tt`) to skip the gate. Trust is
  in-memory only — a fresh node starts over.
- File bytes ride the DTLS-encrypted data channel, device-to-device.
  Discovery relays only the handshake.

## What the hosted build adds (not in this module)

- **STUN/TURN.** `iceServers` defaults to `[]` — host candidates only, so
  connectivity is confined to the local network. The hosted build injects
  STUN, and a TURN relay according to the account's plan (with its own
  relay-usage caps); pass your own servers here to cross NATs.
- The WebSocket discovery implementation, with reconnect/backoff and
  several simultaneous rooms (your code room, an account room, dialed
  codes).
- More receive destinations (an IndexedDB spill tier, save-picker and
  receive-folder modes), a strict LAN-only mode that filters non-local ICE
  candidates in both directions, offline pairing by hand-carried codes, and
  the whole device-grid UI.
