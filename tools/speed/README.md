# Speed Test — orchestration

Measurement plans, summary calibers and the result-history data model of
the [Speed tab on subnsub.com](https://subnsub.com) — published so what
the test runs and how the numbers are tallied is auditable. The transfers
themselves are performed by a third-party engine (below); this module is
everything the site built around it, and it performs no network I/O of
its own.

## Files

- [`speed-orchestrate.js`](speed-orchestrate.js) — the module: plans
  (`PROFILES`, `buildMeasurements()`, `engineConfig()`), calibers
  (`bufferbloat()`, `summarizeResult()`, `bwRows()`, `medianOf()`,
  `fmt*()`), history ledger (`addItem()`, `removeItem()`, `mergeItems()`)
- [`demo.html`](demo.html) — minimal standalone page exercising the
  module on a built-in sample of the engine's output (no real test runs)

## Engine dependency

The site drives [`@cloudflare/speedtest`](https://github.com/cloudflare/speedtest)
(MIT license), which measures download/upload/latency/jitter/packet loss
against Cloudflare's edge (`speed.cloudflare.com` endpoints). That code
is **not** re-published here — only our orchestration is. Two of its
constructor options matter to this module's contract:

- `engineConfig()` sets `logAimApiUrl: null`, so the engine never posts
  AIM telemetry to its default logging endpoint — results stay on the
  page.
- `autoStart` is off because callbacks are wired before `play()`.

## Usage

```js
import {
  buildMeasurements, engineConfig, bufferbloat, summarizeResult,
  bwRows, fmtBps, fmtMs, fmtLoss, fmtLoaded,
  addItem, removeItem, mergeItems,
} from './speed-orchestrate.js';
import SpeedTest from '@cloudflare/speedtest'; // the MIT engine, installed separately

const plan = buildMeasurements('standard', { download: true, upload: true, latency: true });
const engine = new SpeedTest(engineConfig(plan));

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
- `results.getDownloadBandwidthPoints()` / `getUploadBandwidthPoints()` →
  `[{ bytes, bps, duration }]` per sized request. `bwRows()` applies the
  engine's own validity floor (a usable `bps` on a request that ran at
  least 10 ms) before grouping by transfer size.
- The streaming/gaming/RTC grades shown on the site come straight from
  the engine's `getScores()`; they are not re-derived here.
  `bufferbloat()` is the site's own addition.

## Plans

`PROFILES.standard` tracks the engine's default plan (with the WebRTC
packet-loss probe pulled ahead of the sized transfers); `quick` is a
seconds-long pass without the loss probe; `thorough` raises sample counts
and adds a final 100 MB upload. `buildMeasurements()` filters a plan by
the include toggles — packet loss rides the latency toggle, since it is a
latency-family quality probe. An all-off selection yields an empty plan,
which the site refuses to start.

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
