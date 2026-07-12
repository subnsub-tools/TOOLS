/* Speed test orchestration. Core logic of the Speed tab on subnsub.com,
   kept in lockstep with the in-page version.

   The transfers themselves are driven by @cloudflare/speedtest (MIT), a
   third-party engine that measures against Cloudflare's edge network —
   none of that code is here. This module is the layer the site wrote
   around the engine:

     - the measurement plans handed to it (three effort profiles plus
       per-direction include toggles),
     - the summary calibers applied to its results object — bufferbloat
       grading, the clean-finish record shape, raw-sample grouping, and
       the display precision tiers,
     - the pure data model of the result-history ledger (a bounded
       newest-first list; the hosted version persists it server-side).

   Everything here consumes engine output as plain values: no network,
   no DOM, no storage. Units are the engine's throughout — bandwidth in
   bits per second, latency in milliseconds, packet loss a 0–1 ratio. */

/* ── measurement plans ─────────────────────────────────────────────────
   Ordering within a plan is meaningful: transfer sizes ramp up so the
   engine spends its time where the link's capacity actually is, and the
   early bypassMinDuration download warms the connection before anything
   is scored. `standard` tracks the engine's default plan (with the
   packet-loss probe pulled ahead of the sized transfers); `quick` trades
   precision for a seconds-long run and skips the loss probe entirely;
   `thorough` raises sample counts and adds a final 100 MB upload. */
export const PROFILES = {
  quick: [
    { type: 'latency', numPackets: 5 },
    { type: 'download', bytes: 1e5, count: 4, bypassMinDuration: true },
    { type: 'download', bytes: 1e6, count: 4 },
    { type: 'upload', bytes: 1e5, count: 4 },
    { type: 'upload', bytes: 1e6, count: 4 }
  ],
  standard: [
    { type: 'latency', numPackets: 1 },
    { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
    { type: 'latency', numPackets: 20 },
    { type: 'packetLoss', numPackets: 1e3, batchSize: 10, batchWaitTime: 10, responsesWaitTime: 3e3 },
    { type: 'download', bytes: 1e5, count: 9 },
    { type: 'download', bytes: 1e6, count: 8 },
    { type: 'upload', bytes: 1e5, count: 8 },
    { type: 'upload', bytes: 1e6, count: 6 },
    { type: 'download', bytes: 1e7, count: 6 },
    { type: 'upload', bytes: 1e7, count: 4 },
    { type: 'download', bytes: 25e6, count: 4 },
    { type: 'upload', bytes: 25e6, count: 4 },
    { type: 'download', bytes: 1e8, count: 3 },
    { type: 'upload', bytes: 5e7, count: 3 },
    { type: 'download', bytes: 25e7, count: 2 }
  ],
  thorough: [
    { type: 'latency', numPackets: 1 },
    { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
    { type: 'latency', numPackets: 40 },
    { type: 'packetLoss', numPackets: 1e3, batchSize: 10, batchWaitTime: 10, responsesWaitTime: 3e3 },
    { type: 'download', bytes: 1e5, count: 12 },
    { type: 'download', bytes: 1e6, count: 12 },
    { type: 'upload', bytes: 1e5, count: 12 },
    { type: 'upload', bytes: 1e6, count: 8 },
    { type: 'download', bytes: 1e7, count: 8 },
    { type: 'upload', bytes: 1e7, count: 6 },
    { type: 'download', bytes: 25e6, count: 6 },
    { type: 'upload', bytes: 25e6, count: 6 },
    { type: 'download', bytes: 1e8, count: 4 },
    { type: 'upload', bytes: 5e7, count: 4 },
    { type: 'download', bytes: 25e7, count: 3 },
    { type: 'upload', bytes: 1e8, count: 3 }
  ]
};

/* Build the measurement list for one run: the profile's plan minus the
   directions the user excluded. An unknown profile falls back to
   standard. Filtering (rather than reassembling) preserves the plan's
   ramp order. Excluding all three kinds yields an empty plan — the site
   refuses to start such a run.
     profile   'quick' | 'standard' | 'thorough'
     includes  { download, upload, latency } booleans (default all on) */
export function buildMeasurements(profile, includes){
  var inc = includes || { download: true, upload: true, latency: true };
  var m = PROFILES[profile] || PROFILES.standard;
  return m.filter(function(step){
    if (step.type === 'download') return inc.download;
    if (step.type === 'upload') return inc.upload;
    if (step.type === 'latency') return inc.latency;
    /* Packet loss is a latency-family quality probe (WebRTC/TURN) — gate it on
       the Latency toggle so "Download only" doesn't silently run it. */
    if (step.type === 'packetLoss') return inc.latency;
    return true;
  });
}

/* Constructor options the site pairs with a plan. autoStart is off
   because result/phase callbacks are wired before play() is called;
   logAimApiUrl is null so the engine never posts AIM telemetry to its
   default logging endpoint — results stay on the page. */
export function engineConfig(measurements){
  return { autoStart: false, logAimApiUrl: null, measurements: measurements };
}

/* ── display calibers ──────────────────────────────────────────────────
   How numbers are reported everywhere (summary card and history rows
   alike): precision shrinks as magnitude grows, and a metric that was
   not measured is an explicit '—', never a fake zero. */

export function fmtBps(bps){
  if (bps == null) return '—';
  var mbps = bps / 1e6;
  if (mbps >= 1000) return (mbps / 1000).toFixed(1) + ' Gbps';
  if (mbps >= 100) return Math.round(mbps) + ' Mbps';
  if (mbps >= 10) return mbps.toFixed(1) + ' Mbps';
  return mbps.toFixed(2) + ' Mbps';
}

export function fmtMs(ms){
  if (ms == null) return '—';
  return ms < 1 ? '<1 ms' : Math.round(ms) + ' ms';
}

/* Sub-1% loss keeps two decimals — a 0.25% figure matters and would
   vanish at one — while a clean run stays a flat "0%". */
export function fmtLoss(r){
  if (r == null) return '—';
  var pct = r * 100;
  if (pct === 0) return '0%';
  if (pct < 1) return pct.toFixed(2) + '%';
  return pct.toFixed(1) + '%';
}

/* Loaded latency cells carry the latency-under-load AND the jitter-under-load
   ("45 ±8 ms") — the engine reports both and the second is easy to drop
   on the floor. ≤0 means the profile didn't capture loaded latency (e.g.
   quick's short phases) — show — rather than a misleading "0 ms". */
export function fmtLoaded(lat, jit){
  if (lat == null || lat <= 0) return '—';
  return Math.round(lat) + (jit != null && jit > 0 ? ' ±' + Math.round(jit) : '') + ' ms';
}

export function fmtSize(bytes){
  return bytes >= 1e6 ? (bytes / 1e6) + ' MB' : (bytes / 1e3) + ' KB';
}

/* ── scoring over the engine summary ───────────────────────────────────
   `s` below is the engine's results.getSummary() object. */

/* Bufferbloat = how much the round-trip swells once the link is saturated
   (loaded latency − idle latency), graded on the worse of the down/up legs.
   Grade names reuse the engine's score classifications (great … bad) so
   one colour scale covers both. Returns null when there is nothing to
   grade — no idle latency, or neither loaded leg was measured. */
export function bufferbloat(s){
  if (s.latency == null) return null;
  /* Only count a leg whose loaded latency was actually measured (>0). */
  var d = s.downLoadedLatency > 0 ? s.downLoadedLatency - s.latency : null;
  var u = s.upLoadedLatency   > 0 ? s.upLoadedLatency   - s.latency : null;
  if (d == null && u == null) return null;
  var inc = Math.max(0, d != null ? d : 0, u != null ? u : 0);
  var grade = inc <= 20 ? 'great' : inc <= 50 ? 'good' : inc <= 100 ? 'average' : inc <= 200 ? 'poor' : 'bad';
  return { ms: inc, grade: grade };
}

/* The record a finished run contributes to the history ledger — the
   engine summary pinned to the calibers above. Loaded-latency legs use
   the same >0 gate as bufferbloat(): the engine reports ≤0 when a
   profile didn't capture them, and a stored 0 would read as a perfect
   link. Missing metrics become explicit nulls so a latency-only or
   download-only run stays honest in the log. Only CLEAN finishes should
   be recorded: the site keeps partial/aborted runs out, because a
   half-measured download would read as a real dip in the trend. */
export function summarizeResult(s, profile){
  return {
    down: s.download != null ? s.download : null,
    up: s.upload != null ? s.upload : null,
    latency: s.latency != null ? s.latency : null,
    jitter: s.jitter != null ? s.jitter : null,
    loss: s.packetLoss != null ? s.packetLoss : null,
    dlLat: s.downLoadedLatency > 0 ? s.downLoadedLatency : null,
    dlJit: s.downLoadedJitter > 0 ? s.downLoadedJitter : null,
    ulLat: s.upLoadedLatency > 0 ? s.upLoadedLatency : null,
    ulJit: s.upLoadedJitter > 0 ? s.upLoadedJitter : null,
    profile: profile
  };
}

/* ── measurement details ───────────────────────────────────────────────
   The raw samples behind each summary number. */

export function medianOf(a){
  var s = a.slice().sort(function(x, y){ return x - y; });
  var m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}

/* Group raw bandwidth samples (results.get{Download,Upload}BandwidthPoints())
   by transfer size — every sized request becomes one Mbps value under its
   size's row, smallest size first. Same filter as the engine's own
   summary: a usable bps on a request that ran at least
   bandwidthMinRequestDuration (10 ms). */
export function bwRows(points){
  var by = {};
  points.forEach(function(p){
    if (!p.bps || !(p.duration >= 10)) return;
    (by[p.bytes] = by[p.bytes] || []).push(p.bps / 1e6);
  });
  return Object.keys(by).map(Number).sort(function(a, b){ return a - b; }).map(function(b){
    return { label: fmtSize(b), vals: by[b] };
  });
}

/* ── result history ledger ─────────────────────────────────────────────
   The pure data model behind the history list: a bounded, newest-first
   array of finished-run records — summarizeResult() output plus whatever
   identity the store stamps on server-side. The cap is a parameter here;
   on subnsub.com it is configured server-side and the server rolls the
   oldest row off (FIFO), so saving never needs gardening and never
   refuses. Every op returns a fresh array. */

/* Prepend the newest record and trim to the cap — adding at the cap
   rolls the oldest row off the end. */
export function addItem(items, item, cap){
  return [item].concat(items || []).slice(0, cap);
}

export function removeItem(items, id){
  return (items || []).filter(function(x){ return x.id !== id; });
}

/* Merge a stored snapshot with local writes that landed while it was
   being fetched: dedupe by id (local first — it carries the newest
   save), drop rows the caller deleted meanwhile (deletedIds is a
   set-like object, id → truthy), newest first, cap-trim. Without this,
   a slow list fetch resolving after a save/delete would clobber them. */
export function mergeItems(server, local, deletedIds, cap){
  var seen = {}, out = [];
  var del = deletedIds || {};
  (local || []).concat(server).forEach(function(it){
    if (!it || seen[it.id] || del[it.id]) return;
    seen[it.id] = 1; out.push(it);
  });
  out.sort(function(a, b){ return b.savedAt - a.savedAt; });
  return out.slice(0, cap);
}
