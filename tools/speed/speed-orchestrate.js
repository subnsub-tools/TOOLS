/* Speed test orchestration. Logic of the Speed tab on subnsub.com,
   kept in lockstep with the in-page version.

   The transfers themselves are driven by @cloudflare/speedtest (MIT), a
   third-party engine that measures against Cloudflare's edge network —
   none of that code is here. This module is the layer the site wrote
   around the engine:

     - the measurement plans handed to it (three effort profiles plus
       per-direction include toggles) and the constructor options paired
       with a plan,
     - the one run-control rule the site enforces around the engine's
       pause(): which phases may be interrupted,
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
   `thorough` raises sample counts and adds a final 100 MB upload.

   standard/thorough interleave 2-packet idle-latency steps between the
   sized bandwidth rounds, mirroring the engine's 1.13 plan: the engine
   accumulates every latency step into one timing set, so the idle
   latency/jitter summary samples the whole run instead of only its
   first seconds. packetLoss stays pulled up right after the first
   latency burst (unlike upstream, which runs it after the first upload
   round) so a TURN-blocked network shows its blank Packet Loss cell
   early rather than minutes in. */
export const PROFILES = {
  quick: [
    { type: 'latency', numPackets: 5 },
    { type: 'download', bytes: 1e5, count: 4, bypassMinDuration: true },
    { type: 'download', bytes: 1e6, count: 4 },
    { type: 'upload', bytes: 1e5, count: 4 },
    { type: 'upload', bytes: 1e6, count: 4 }
  ],
  standard: [
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
    { type: 'latency', numPackets: 20 },
    { type: 'packetLoss', numPackets: 1e3, batchSize: 10, batchWaitTime: 10, responsesWaitTime: 3e3 },
    { type: 'download', bytes: 1e5, count: 9 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1e6, count: 8 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 1e5, count: 8 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 1e6, count: 6 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1e7, count: 6 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 1e7, count: 4 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 25e6, count: 4 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 25e6, count: 4 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1e8, count: 3 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 5e7, count: 3 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 25e7, count: 2 }
  ],
  thorough: [
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
    { type: 'latency', numPackets: 40 },
    { type: 'packetLoss', numPackets: 1e3, batchSize: 10, batchWaitTime: 10, responsesWaitTime: 3e3 },
    { type: 'download', bytes: 1e5, count: 12 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1e6, count: 12 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 1e5, count: 12 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 1e6, count: 8 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1e7, count: 8 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 1e7, count: 6 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 25e6, count: 6 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 25e6, count: 6 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1e8, count: 4 },
    { type: 'latency', numPackets: 2 },
    { type: 'upload', bytes: 5e7, count: 4 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 25e7, count: 3 },
    { type: 'latency', numPackets: 2 },
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
   default logging endpoint — results stay on the page.

   turnServerCredsApiUrl replaces the engine's default credentials
   endpoint for the packet-loss probe. speed.cloudflare.com/turn-creds
   went same-origin-only (403 + no ACAO for foreign Origins, verified
   2026-08-11), which silently killed the WebRTC probe on any other
   site — and with it the packetLoss input that feeds all three
   experience scores. The site answers from its own minting endpoint
   (/api/speed-turn, short-lived anonymous Cloudflare Realtime TURN
   credentials) in the same { username, credential, server } shape the
   engine's default parser destructures; on its { error } answers the
   engine records the usual credentials failure and the run continues
   loss-blind, same as on UDP-hostile networks. The site's path is the
   default here; another deployment passes the URL of its own endpoint.
     measurements          buildMeasurements() output
     turnServerCredsApiUrl optional, default '/api/speed-turn' */
export const DEFAULT_TURN_CREDS_URL = '/api/speed-turn';
export function engineConfig(measurements, turnServerCredsApiUrl){
  return {
    autoStart: false,
    logAimApiUrl: null,
    turnServerCredsApiUrl: turnServerCredsApiUrl || DEFAULT_TURN_CREDS_URL,
    measurements: measurements
  };
}

/* ── run control ───────────────────────────────────────────────────────
   Whether a pause request may be handed to engine.pause() while a step
   of this type is running. Bandwidth and latency steps pause cleanly
   (the in-flight request aborts, play() resumes exactly where it
   stopped, and totalDurationMs already excludes paused wall-time). The
   packet-loss step is the exception: its WebRTC engine has no pause,
   and worse, engine.pause()/play() around it corrupt the run — pause()
   marks the engine stopped while the probe keeps going, so a resume
   would advance into the following step and the probe's own finish
   would advance AGAIN, overlapping two measurements. The site therefore
   never touches the engine during packet loss: it banks the intent and
   applies the real pause at the next phase boundary (onPhaseChange),
   and a resume only calls play() on an engine that actually stopped.
     type  the measurement type from onPhaseChange's payload */
export function pausablePhase(type){
  return type !== 'packetLoss';
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

/* ── What a result means (the tab's "What this connection can do") ──
   r is summarizeResult()'s shape: { down, up (bps), latency, jitter (ms),
   loss (0-1), dlLat, ulLat (latency under load, ms) } — null where the
   profile did not measure it. */

/* Rules of thumb the streaming and conferencing services publish: a 4K
   stream ~25 Mbps, an HD one ~5; an HD call wants 3 Mbps each way, latency
   under load below 150 ms, jitter below 30, loss below 1%; 1080p cloud
   gaming wants 25 Mbps down, 40 ms idle, 10 ms jitter, 0.5% loss. `needs`
   are the readings a verdict cannot be given without; the rest count when
   present. */
export const USE_RULES = {
  stream4k: 25e6, streamHd: 5e6,
  call: { down: 3e6, up: 3e6, loaded: 150, jitter: 30, loss: 0.01, needs: ['down', 'up'] },
  game: { down: 25e6, latency: 40, jitter: 10, loss: 0.005, needs: ['down', 'latency'] }
};
const loadedOf = (r) => (r.dlLat != null && r.ulLat != null ? Math.max(r.dlLat, r.ulLat) : (r.dlLat != null ? r.dlLat : r.ulLat));
/* The first requirement a use misses: { key, value } (value in the
   reading's own unit), { key: 'na' } when an essential reading is missing,
   or null when it holds. key ∈ down | up | lat | load | jit | loss | na. */
export function useMiss(r, need){
  if (need.needs.some(k => r[k] == null)) return { key: 'na' };
  if (need.down && r.down != null && r.down < need.down) return { key: 'down', value: r.down };
  if (need.up && r.up != null && r.up < need.up) return { key: 'up', value: r.up };
  if (need.latency && r.latency != null && r.latency > need.latency) return { key: 'lat', value: r.latency };
  const ld = loadedOf(r);
  if (need.loaded && ld != null && ld > need.loaded) return { key: 'load', value: ld };
  if (need.jitter && r.jitter != null && r.jitter > need.jitter) return { key: 'jit', value: r.jitter };
  if (need.loss && r.loss != null && r.loss > need.loss) return { key: 'loss', value: r.loss };
  return null;
}
/* → { streams4k, streamsHd, call, game } — counts, and useMiss() verdicts */
export function speedUses(r){
  return {
    streams4k: r.down != null ? Math.floor(r.down / USE_RULES.stream4k) : null,
    streamsHd: r.down != null ? Math.floor(r.down / USE_RULES.streamHd) : null,
    call: useMiss(r, USE_RULES.call),
    game: useMiss(r, USE_RULES.game)
  };
}
/* seconds to move `bytes` at `bps` (decimal gigabytes: 1 GB = 8e9 bits) */
export const transferSeconds = (bytes, bps) => (bps > 0 ? bytes * 8 / bps : null);

/* AIM's own scoring (the engine's internalConfig): each experience sums
   points from its readings; the reading that lost the most of its best
   is what holds the rating back. Under 10 points short is not "holding it
   back" — that is one step down from the best. → reading name or null. */
const AIM_POINTS = {
  packetLoss: [[0.01, 0.05, 0.25, 0.5], [10, 5, 0, -10, -20]],
  latency: [[10, 20, 50, 100, 500], [20, 10, 5, 0, -10, -20]],
  loadedLatencyIncrease: [[10, 20, 50, 100, 500], [20, 10, 5, 0, -10, -20]],
  jitter: [[10, 20, 100, 500], [10, 5, 0, -10, -20]],
  download: [[1e6, 1e7, 5e7, 1e8], [0, 5, 10, 20, 30]]
};
export const AIM_INPUTS = {
  streaming: ['latency', 'packetLoss', 'download', 'loadedLatencyIncrease'],
  gaming: ['latency', 'packetLoss', 'loadedLatencyIncrease'],
  rtc: ['latency', 'jitter', 'packetLoss', 'loadedLatencyIncrease']
};
export function aimPoints(metric, v){
  const [dom, rng] = AIM_POINTS[metric];
  let i = 0; while (i < dom.length && v >= dom[i]) i++;
  return { got: rng[i], best: Math.max(rng[0], rng[rng.length - 1]) };
}
export function scoreBottleneck(r, experience){
  const ld = loadedOf(r);
  const val = { latency: r.latency, packetLoss: r.loss, download: r.down, jitter: r.jitter,
                loadedLatencyIncrease: ld != null && r.latency != null ? ld - r.latency : null };
  let worst = null, lost = 0;
  for (const m of AIM_INPUTS[experience]) {
    if (val[m] == null) continue;
    const p = aimPoints(m, val[m]), l = p.best - p.got;
    if (l > lost) { lost = l; worst = m; }
  }
  return lost >= 10 ? worst : null;
}

/* This device's usual: the median of up to the last 10 earlier clean runs
   ({ d, u, l } = down bps, up bps, latency ms) against this one. Percent
   for the speeds, milliseconds for latency; null with fewer than 3. */
export function compareToUsual(log, r){
  const prev = (log || []).slice(-10);
  if (prev.length < 3) return null;
  const md = medianOf(prev.map(x => x.d)), mu = medianOf(prev.map(x => x.u)), ml = medianOf(prev.map(x => x.l));
  const pct = (a, b) => (a == null || !b ? null : Math.round((a / b - 1) * 100));
  return { runs: prev.length, down: pct(r.down, md), up: pct(r.up, mu),
           latency: r.latency != null && ml != null ? Math.round(r.latency - ml) : null };
}
