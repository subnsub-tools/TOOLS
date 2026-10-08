# Speed Test — orchestration

Measurement plans, summary calibers and the result-history data model of
the [Speed tab on subnsub.com](https://subnsub.com) — published so what
the test runs and how the numbers are tallied is auditable. The transfers
themselves are performed by a third-party engine (below); this module is
everything the site built around it, and it performs no network I/O of
its own.

## Files

- [`speed-orchestrate.js`](speed-orchestrate.js) — the module: plans
  (`PROFILES`, `buildMeasurements()`, `engineConfig()`,
  `DEFAULT_TURN_CREDS_URL`), run control (`pausablePhase()`), calibers
  (`bufferbloat()`, `summarizeResult()`, `bwRows()`, `medianOf()`,
  `fmt*()`), history ledger (`addItem()`, `removeItem()`, `mergeItems()`)
- [`demo.html`](demo.html) — minimal standalone page exercising the
  module on a built-in sample of the engine's output (no real test runs)

## Engine dependency

The site drives [`@cloudflare/speedtest`](https://github.com/cloudflare/speedtest)
1.13 (MIT license), which measures download/upload/latency/jitter/packet
loss against Cloudflare's edge (`speed.cloudflare.com/__down` and
`/__up` for transfers; a TURN relay for the packet-loss probe). That
code is **not** re-published here — only our orchestration is. Three of
its constructor options matter to this module's contract:

- `engineConfig()` sets `logAimApiUrl: null`, so the engine never posts
  AIM telemetry to its default logging endpoint (since 1.13 that default
  is `speed.cloudflare.com/__results`; before, `aim.cloudflare.com/__log`)
  — results stay on the page. The engine's `onResultsLogged` hook
  therefore never fires.
- `engineConfig()` sets `turnServerCredsApiUrl` to the site's own
  credentials endpoint (`/api/speed-turn`, exported as
  `DEFAULT_TURN_CREDS_URL`; pass your own as the second argument). The
  engine's default, `speed.cloudflare.com/turn-creds`, went
  same-origin-only (403 + no ACAO for foreign Origins, verified
  2026-08-11), which silently disables the WebRTC packet-loss probe on
  any other site — and with it the `packetLoss` input to all three
  experience scores. The endpoint must answer the shape the engine's
  default `turnServerCredsApiParser` destructures,
  `{ username, credential, server }`; on an `{ error }` answer the engine
  records a credentials failure and the run continues without a loss
  number, as it does on UDP-hostile networks. The site mints
  short-lived (300 s) anonymous Cloudflare Realtime TURN credentials
  behind per-IP and sitewide rate windows; that server code is not part
  of this module.
- `autoStart` is off because callbacks are wired before `play()`.

## Usage

```js
import {
  buildMeasurements, engineConfig, pausablePhase, bufferbloat, summarizeResult,
  bwRows, fmtBps, fmtMs, fmtLoss, fmtLoaded,
  addItem, removeItem, mergeItems,
} from './speed-orchestrate.js';
import SpeedTest from '@cloudflare/speedtest'; // the MIT engine, installed separately

const plan = buildMeasurements('standard', { download: true, upload: true, latency: true });
const engine = new SpeedTest(engineConfig(plan /*, '/your/turn-creds' */));

// Pause/Resume: hand engine.pause() only to phases that can take it;
// during packet loss bank the request and apply it at the next
// onPhaseChange (see "Run control" below).
let phase = null;
engine.onPhaseChange = (p) => { phase = p.measurement && p.measurement.type; };
const requestPause = () => { if (pausablePhase(phase)) engine.pause(); /* else: bank it */ };

engine.onFinish = (results) => {
  const s = results.getSummary();
  console.log(fmtBps(s.download), fmtBps(s.upload));        // "94.4 Mbps" "28.7 Mbps"
  console.log(fmtMs(s.latency), fmtLoss(s.packetLoss));     // "14 ms" "0.25%"
  console.log(fmtLoaded(s.downLoadedLatency, s.downLoadedJitter)); // "49 ±8 ms"
  console.log(bufferbloat(s));                              // { ms: 82.1, grade: 'average' }
  console.log(bwRows(results.getDownloadBandwidthPoints())); // [{ label: '100 KB', vals: [...] }, …]

  // The record a clean finish contributes to the history:
  const record = summarizeResult(s, 'standard');

  // Ledger ops are pure — persistence is the caller's business:
  let items = [];
  items = addItem(items, { id: 'r1', savedAt: Date.now(), ...record }, 10);
  items = mergeItems(itemsFromStore, items, deletedIds, 10);
  items = removeItem(items, 'r1');
};
engine.play();
```

## Engine results contract

The module consumes the engine's results object as plain values:

- `results.getSummary()` →
  `{ download, upload, latency, jitter, packetLoss, downLoadedLatency,
  downLoadedJitter, upLoadedLatency, upLoadedJitter, totalDurationMs }` —
  bandwidth in **bits/s**, latency in **ms**, loss a **0–1 ratio**.
  Loaded-latency fields report `≤ 0` when the run's profile didn't
  capture them; `bufferbloat()` and `summarizeResult()` both gate on
  `> 0` so an unmeasured leg can never read as a perfect link.
  Since 1.13 the engine accumulates **every** idle `latency` step of the
  plan into one timing set, so `latency`/`jitter` are the percentile over
  the whole run — which is why the standard/thorough plans interleave
  2-packet latency steps between the sized rounds. Idle latency is also
  measured more honestly than before: the edge now splits
  `Server-Timing` into `cfSpeedEdge`/`cfSpeedWorker` entries and the
  engine subtracts their sum (older builds subtracted only the first,
  so ~30 ms of worker time read as network), with a small calibrated
  `serverTimeDelta` on HTTP/1.x connections. Every sized request (uploads
  too, since 1.13) carries a `bytes` query parameter.
- `results.getDownloadBandwidthPoints()` / `getUploadBandwidthPoints()` →
  `[{ bytes, bps, duration }]` per sized request. `bwRows()` applies the
  engine's own validity floor (a usable `bps` on a request that ran at
  least 10 ms) before grouping by transfer size.
- The streaming/gaming/RTC grades shown on the site come straight from
  the engine's `getScores()`; they are not re-derived here.
  `bufferbloat()` is the site's own addition.

## Plans

`PROFILES.standard` tracks the engine's 1.13 default plan — a 2-packet
latency opener, a warm-up download, a 20-packet latency burst, then the
sized rounds with a 2-packet idle-latency step between each — with the
WebRTC packet-loss probe pulled ahead of the sized transfers (upstream
runs it after the first upload round) so a TURN-blocked network shows its
blank Packet Loss cell early rather than minutes in; `quick` is a
seconds-long pass without the loss probe or the interleaved steps;
`thorough` raises sample counts and adds a final 100 MB upload.
`buildMeasurements()` filters a plan by the include toggles — packet loss
rides the latency toggle, since it is a latency-family quality probe, and
with latency off the interleaved steps go too, so a bandwidth-only run
has no idle baseline and `bufferbloat()` returns null. An all-off
selection yields an empty plan, which the site refuses to start.

## Run control

The site offers Pause/Resume while a run is live, over the engine's own
`pause()`/`play()`: bandwidth and latency steps pause cleanly (the
in-flight request aborts, `play()` resumes exactly where it stopped, and
`totalDurationMs` already excludes paused wall-time). The packet-loss
step cannot be paused — its WebRTC engine has no pause, and calling
`engine.pause()` during it marks the engine stopped while the probe keeps
going, so a resume would advance into the next step and the probe's own
finish would advance again, overlapping two measurements.
`pausablePhase(type)` is that rule: when it is false the site banks the
request and applies the real `pause()` on the next `onPhaseChange`;
resume only calls `play()` on an engine that actually stopped.

## History model

A bounded, newest-first array of finished-run records. Only **clean**
finishes are recorded — a partially-failed run would read as a real dip
in the trend. The cap is a parameter here; on subnsub.com the ledger is
kept server-side per signed-in account with a server-configured cap, and
the **server** rolls the oldest row off (FIFO), so saving never needs
gardening. `mergeItems()` exists because a slow list fetch can
resolve after local saves/deletes — it reconciles instead of clobbering
(dedupe by id, local first; deleted ids stay deleted; newest first;
cap-trim).

## What a result means

The tab's "What this connection can do" card reads the summary
(`summarizeResult()`'s shape) four ways:

```js
import { speedUses, transferSeconds, scoreBottleneck, compareToUsual } from './speed-orchestrate.js';

const r = { down: 120e6, up: 20e6, latency: 15, jitter: 3, loss: 0, dlLat: 60, ulLat: 210 };
speedUses(r);
// { streams4k: 4, streamsHd: 24,
//   call: { key: 'load', value: 210 },   // latency under load over 150 ms
//   game: null }                          // holds
transferSeconds(10e9, r.down);           // 666.7 — a 10 GB download
scoreBottleneck(r, 'gaming');            // 'loadedLatencyIncrease'
compareToUsual(lastRuns, r);             // { runs: 4, down: 20, up: 0, latency: -5 }
```

- **Uses** are rules of thumb the streaming and conferencing services
  publish (`USE_RULES`): ~25 Mbps a 4K stream, ~5 an HD one; an HD call
  wants 3 Mbps each way, latency under load below 150 ms, jitter below 30,
  loss below 1%; 1080p cloud gaming 25 Mbps down, 40 ms idle, 10 ms jitter,
  0.5% loss. A use whose essential readings were not measured (a profile
  without upload) comes back `{ key: 'na' }` — not judged, never a pass.
- **The bottleneck** is AIM's own scoring, the one the engine grades with:
  the reading that lost the most of its best points, if it lost at least
  10 of them (one step short of the best is not "holding it back").
- **The usual** is the median of up to ten earlier clean runs; the tab
  keeps that log on the device only and never sends it anywhere.
