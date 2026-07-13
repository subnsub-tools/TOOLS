/* Melody Catcher engine — core logic of the Melody Catcher tab on
   subnsub.com, kept in lockstep with the in-page version.

   Audition equal-temperament pitches, keep the ones that match the tune
   in your head, and replay the captured sequence at an adjustable tempo.
   100% local: tones are synthesized with the Web Audio API and nothing
   leaves the browser.

   Sequence format (what the site persists, syncs and saves): a plain JSON
   array, one entry per one-beat slot — either a MIDI note number within
   the 88-key piano range (21 = A0 … 108 = C8) or the string 'R' for a
   rest. sanitizeSequence() is the single gate every external payload
   passes through.

   Voice: two oscillators (triangle at f, sine at 2f mixed at 0.16) into a
   gentle lowpass (7·f, capped at 9 kHz, Q 0.6), with a fast exponential
   attack (5 ms) and an exponential release across the note's duration —
   a soft plucked tone that stays inoffensive over the whole range.

   Playback schedules one pass at a time on the audio clock; each pass
   re-anchors the next at its exact end, so looping is seamless (no
   setTimeout drift) and a tempo change lands on the next pass.

   MIDI: export builds a format-0 Standard MIDI File — one slot = one
   quarter note at the chosen BPM, gate 0.92, tempo embedded, so the file
   plays back exactly like the in-app playback. Import parses an SMF and
   flattens it onto the slot model: all tracks merge, chords collapse to
   their top note (skyline melody), note starts snap to the coarsest grid
   that fits every inter-note gap, rests fill the gaps, and the file's
   tempo maps onto the BPM. A file saved by this tool round-trips exactly.

   Rhythm capture (the site's Record button): each played key is stamped
   ({ t: seconds, m: midi }) and quantizeTaps() flattens the stamps onto
   the same slot model — chords collapse to their top note, the beat unit
   is estimated from the fastest class of inter-tap gaps, gaps become
   rests, and the unit maps onto the BPM — so a recorded take plays,
   saves and exports through the same pipeline unchanged.

   The synth half needs the Web Audio API (any modern browser); the
   sequence / MIDI half is plain computation. */

export const LO_ALL = 21, HI_ALL = 108;         // full piano: A0 … C8, 88 keys
export const DEFAULT_BPM = 100;
export const GATE = 0.92;                       // note sounds for this fraction of its beat (playback + MIDI export)
export const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
export const mod12 = m => ((m % 12) + 12) % 12;
export const isBlack = m => !WHITE.has(mod12(m));
export const noteName = m => NAMES[mod12(m)] + (Math.floor(m / 12) - 1);
export const freq = m => 440 * Math.pow(2, (m - 69) / 12);
export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export function inScale(m, root) { if (root < 0) return true; return MAJOR.includes(((m % 12) - root + 12) % 12); }

/* ── sequence model ── */

/* The one gate every external sequence passes through (persisted state,
   sync payloads, saved melodies, anything hand-crafted): keep rests and
   MIDI numbers within the 88-key range, drop everything else. */
export function sanitizeSequence(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(x => x === 'R' || (typeof x === 'number' && Number.isInteger(x) && x >= LO_ALL && x <= HI_ALL));
}

/* ── audio ── */
let actx = null, liveNodes = [], audioPrimed = false, audioResume = null;
function ac() {
  if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; try { actx = new C(); } catch (_) { return null; } }
  return actx;
}
/* Autoplay policies suspend a context created outside a gesture. Priming
   plays a one-sample silent buffer; resumeAudio() is safe to call from any
   user gesture and resolves with a running context (or null). */
function primeAudio(c) {
  if (!c || audioPrimed) return;
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, c.sampleRate || 44100);
    src.connect(c.destination);
    if (src.start) src.start(0); else if (src.noteOn) src.noteOn(0);
    if (!c.state || c.state === 'running') audioPrimed = true;
  } catch (_) {}
}
function whenAudioRunning(c) {
  if (!c || !c.state || c.state === 'running') return Promise.resolve(c);
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { c.removeEventListener && c.removeEventListener('statechange', onChange); } catch (_) {}
      primeAudio(c);
      resolve((!c.state || c.state === 'running') ? c : null);
    };
    const onChange = () => { if (!c.state || c.state === 'running') finish(); };
    try { c.addEventListener && c.addEventListener('statechange', onChange); } catch (_) {}
    setTimeout(finish, 250);
  });
}
export function resumeAudio() {
  const c = ac(); if (!c || c.state === 'closed') return Promise.resolve(null);
  primeAudio(c);
  if (!c.state || c.state === 'running' || !c.resume) return Promise.resolve(c);
  if (audioResume) return audioResume;
  try {
    audioResume = Promise.resolve(c.resume()).catch(() => null).then(() => {
      audioResume = null;
      return whenAudioRunning(c);
    });
    return audioResume;
  } catch (_) {
    audioResume = null;
    return Promise.resolve((!c.state || c.state === 'running') ? c : null);
  }
}
function startVoice(c, f, t0, dur, peak) {
  t0 = Math.max(c.currentTime + 0.01, t0 || c.currentTime);
  const g = c.createGain();
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(f * 7, 9000); lp.Q.value = 0.6;
  const o1 = c.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
  const o2 = c.createOscillator(); o2.type = 'sine';     o2.frequency.value = f * 2;
  const g2 = c.createGain(); g2.gain.value = 0.16;
  o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(lp); lp.connect(c.destination);
  const A = 0.005, p = Math.max(0.0001, peak || 0.22), rel = Math.max(A + 0.04, dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(p, t0 + A);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + rel);
  const end = t0 + rel + 0.05;
  o1.start(t0); o2.start(t0); o1.stop(end); o2.stop(end);
  const entry = { o1, o2 }; liveNodes.push(entry);
  o1.onended = () => { const i = liveNodes.indexOf(entry); if (i >= 0) liveNodes.splice(i, 1); };
}
/* One-shot note at frequency f, starting at absolute audio time t0 (or
   now), sounding for dur seconds at the given peak gain. Resumes a
   suspended context first when needed. */
export function voice(f, t0, dur, peak) {
  const c = ac(); if (!c) return null;
  if (!c.state || c.state === 'running') { startVoice(c, f, t0, dur, peak); return null; }
  resumeAudio().then(rc => { if (rc && (!rc.state || rc.state === 'running')) startVoice(rc, f, Math.max(rc.currentTime, t0 || 0), dur, peak); });
  return null;
}
function startHoldVoice(c, f, peak) {
  const g = c.createGain();
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(f * 7, 9000); lp.Q.value = 0.6;
  const o1 = c.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
  const o2 = c.createOscillator(); o2.type = 'sine';     o2.frequency.value = f * 2;
  const g2 = c.createGain(); g2.gain.value = 0.16;
  o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(lp); lp.connect(c.destination);
  const p = Math.max(0.0001, peak || 0.22), t0 = c.currentTime + 0.01;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(p, t0 + 0.005);
  o1.start(t0); o2.start(t0);
  const entry = { o1, o2 }; liveNodes.push(entry);
  let stopped = false;
  return { stop() { if (stopped) return; stopped = true; const now = c.currentTime; g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value || p, now); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08); o1.stop(now + 0.13); o2.stop(now + 0.13); o1.onended = () => { const i = liveNodes.indexOf(entry); if (i >= 0) liveNodes.splice(i, 1); }; } };
}
/* Sustained note (press-and-hold keys): returns { stop() } which releases
   with a short 80 ms ramp instead of a hard cut. */
export function holdVoice(f, peak) {
  const c = ac(); if (!c) return null;
  if (!c.state || c.state === 'running') return startHoldVoice(c, f, peak);
  let started = null, cancelled = false;
  resumeAudio().then(rc => { if (!cancelled && rc && (!rc.state || rc.state === 'running')) started = startHoldVoice(rc, f, peak); });
  return { stop() { cancelled = true; if (started) started.stop(); } };
}
/* Hard-stop every live oscillator (playback voices, audition tails, held
   notes) — what the in-page tool does whenever playback is interrupted. */
export function stopAllVoices() {
  liveNodes.forEach(n => { try { n.o1.stop(); } catch (_) {} try { n.o2.stop(); } catch (_) {} });
  liveNodes = [];
}
/* The click-a-key audition tone: 0.7 s at a slightly hotter peak than
   playback, after making sure the context is actually running. */
export function audition(m) {
  resumeAudio().then(c => {
    if (!c || (c.state && c.state !== 'running')) return;
    startVoice(c, freq(m), c.currentTime + 0.01, 0.7, 0.26);
  });
}

/* ── playback ── */

/* Sequence player. Options (all optional):
     bpm     number | () => number — re-read at the start of every pass,
             so a mid-play tempo change takes effect on the next loop
             (default DEFAULT_BPM)
     loop    boolean | () => boolean — read live at each pass boundary
     onSlot  (i, item) — fires as slot i begins sounding (UI highlight)
     onStart () / onStop () — playback state edges for the host UI
   play(seq) is a toggle (stops when already playing) and holds the array
   by reference, exactly like the in-page tool — mutations that must not
   sound mid-pass should stop() first. */
export function createPlayer(opts) {
  opts = opts || {};
  const bpmOf = () => parseInt(typeof opts.bpm === 'function' ? opts.bpm() : opts.bpm, 10) || DEFAULT_BPM;
  const loopOn = () => !!(typeof opts.loop === 'function' ? opts.loop() : opts.loop);
  let playing = false, playStarting = false, playTimers = [], playEndTimer = null, melody = [];
  function stop() {
    playing = false; playStarting = false;
    playTimers.forEach(clearTimeout); playTimers = [];
    if (playEndTimer) { clearTimeout(playEndTimer); playEndTimer = null; }
    stopAllVoices();
    if (opts.onStop) opts.onStop();
  }
  /* One pass over the melody, scheduled to begin at the absolute Web Audio
     time `startTime`. Re-entrant: on finish it either queues the next pass
     anchored to THIS pass's exact end (seamless loop — no per-pass gap or
     clock drift, since each pass begins right where the last ended on the
     audio clock) or stops. BPM is re-read each pass, so a mid-play tempo
     change takes effect on the next loop. */
  function scheduleRun(startTime) {
    const c = ac(); if (!c) return;
    playTimers.forEach(clearTimeout); playTimers = [];   // prior pass's timers have all fired
    const bpm = bpmOf();
    const beat = 60 / bpm, gate = GATE;
    const t0 = startTime;
    melody.forEach((it, i) => {
      const when = t0 + i * beat;
      if (it !== 'R') voice(freq(it), when, beat * gate, 0.24);
      const delayMs = Math.max(0, (when - c.currentTime) * 1000);
      playTimers.push(setTimeout(() => { if (opts.onSlot) opts.onSlot(i, it); }, delayMs));
    });
    const nextStart = t0 + melody.length * beat;
    /* Loop: wake ~50ms before the boundary to queue the next pass on the
       audio clock ahead of time (seamless). Non-loop: wake just after the
       end so the final note rings out fully before the UI resets. */
    const wakeAt = loopOn() ? nextStart - 0.05 : nextStart + 0.10;
    playEndTimer = setTimeout(() => {
      if (loopOn() && playing) scheduleRun(nextStart);
      else stop();
    }, Math.max(0, (wakeAt - c.currentTime) * 1000));
  }
  function play(seq) {
    if (playing || playStarting) { stop(); return; }
    melody = seq || [];
    if (!melody.length) return;
    playStarting = true;
    resumeAudio().then(c => {
      if (!playStarting || !c || (c.state && c.state !== 'running')) { playStarting = false; return; }
      playStarting = false; playing = true;
      if (opts.onStart) opts.onStart();
      scheduleRun(c.currentTime + 0.06);
    });
  }
  return { play, stop, get playing() { return playing || playStarting; } };
}

/* ── rhythm capture ──
   The Record flow: arm, then just play — the first key press starts the
   clock and every press is stamped { t: seconds since the first tap,
   m: MIDI note }. quantizeTaps() turns the stamps into a sequence. */
export const REC_CHORD = 0.06;             // taps this close (s) = one chord — skyline, like import
export const REC_GAP_CAP = 32;             // one pause can widen to at most this many slots
export function quantizeTaps(taps, fallbackBpm) {
  const ons = [];
  taps.forEach(tp => {
    const last = ons[ons.length - 1];
    if (last && tp.t - last.t <= REC_CHORD) { if (tp.m > last.m) last.m = tp.m; }
    else ons.push({ t: tp.t, m: tp.m });
  });
  if (ons.length === 1) return { seq: [ons[0].m], bpm: fallbackBpm };
  const gaps = [];
  for (let i = 1; i < ons.length; i++) gaps.push(ons[i].t - ons[i - 1].t);
  /* beat unit = mean of the fastest class of gaps (within 1.45× of the
     shortest — one class can't straddle a 2:1 rhythm ratio, so this
     absorbs human jitter without swallowing the next duration up).
     Halve it once when the finer grid fits the whole take clearly
     better: a dotted figure like 1.5×-1×-2× only lands when the unit
     is the half, and "clearly" (< half the error) keeps plain even
     tapping, whose error the halved grid merely ties, on the coarse
     grid. */
  const minG = Math.min.apply(null, gaps);
  const fast = gaps.filter(g => g <= minG * 1.45);
  const unit = fast.reduce((a, b) => a + b, 0) / fast.length;
  /* Candidate tempi: the fast-class unit and its subdivisions (k ≤ 8
     still catches a 3-in-4s figure), each pushed through the same BPM
     rounding/clamp the generator uses. Scoring replays the generator's
     exact arithmetic — including the per-gap slot cap, so a fine grid
     can't win on paper while the cap mangles it in practice (a 16s
     pause reads as 32 capped slots ≈ 16s at 120 BPM but 8s at 240) —
     and a finer grid must clearly beat the standing one (half the
     error), which keeps even tapping with human jitter on the coarse
     grid. Slow takes lean on the subdivisions: a 2s pulse clamped to
     40 BPM lands 25% off, while k=2 expresses it exactly as
     note-rest-note at 60 BPM. */
  const fit = b => { const u = 60 / b; return gaps.reduce((s, g) => s + Math.abs(g - Math.max(1, Math.min(REC_GAP_CAP, Math.round(g / u))) * u), 0); };
  let bpm = Math.max(40, Math.min(240, Math.round(60 / unit)));
  let best = fit(bpm);
  for (let k = 2; k <= 8; k++) {
    /* a grid that already fits to human precision (20ms per gap — timer
       and finger jitter) can't be "clearly beaten": with one or two gaps
       a subdivision can always hug them near-perfectly, so without this
       floor rounding residue would pick the grid at random. Structural
       misfits (dotted/2:3 figures) sit at 80ms+ per gap and still pass. */
    if (best <= gaps.length * 0.02) break;
    const c = Math.max(40, Math.min(240, Math.round(60 / (unit / k))));
    if (c === bpm) continue;
    const f = fit(c);
    if (f < best * 0.5) { best = f; bpm = c; }
  }
  const grid = 60 / bpm;
  const seq = [ons[0].m];
  for (let i = 1; i < ons.length; i++) {
    /* unlike import's hard reject, a too-long take is truncated at the
       slot cap — refusing would throw away the user's own performance.
       The break is all-or-nothing per note: filling part of a pause and
       then pushing the note would mis-time it onto the wrong slot */
    const n = Math.max(1, Math.min(REC_GAP_CAP, Math.round(gaps[i - 1] / grid)));
    if (seq.length + n > MAX_IMPORT) break;
    for (let r = 1; r < n; r++) seq.push('R');
    seq.push(ons[i].m);
  }
  return { seq, bpm };
}

/* ── MIDI export (Standard MIDI File, format 0) ──
   Each melody slot is one quarter note at the given BPM; rests are gaps,
   and the tempo is embedded so the file plays back exactly like the
   in-app playback. Bytes are assembled in-memory — nothing is uploaded. */
export const PPQ = 480;
function vlq(n) {                        // variable-length quantity (MIDI delta-times)
  if (n < 0) n = 0; else if (n > 0x0FFFFFFF) n = 0x0FFFFFFF;   // SMF VLQ is ≤4 bytes — never emit invalid bytes
  const b = [n & 0x7f]; n = Math.floor(n / 128);
  while (n > 0) { b.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  return b;
}
const sbytes = s => Array.from(s, c => c.charCodeAt(0));
const u16 = n => [(n >> 8) & 0xff, n & 0xff];
const u32 = n => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
export function buildMidi(seq, bpm) {
  bpm = parseInt(bpm, 10) || DEFAULT_BPM;
  const noteDur = Math.round(PPQ * GATE);  // matches playback gate; the small gap also retriggers repeated notes
  const VEL = 80;
  const evs = []; let t = 0;
  seq.forEach(it => {
    if (it !== 'R') {
      evs.push({ tick: t,           ord: 1, bytes: [0x90, it, VEL] });   // note on,  ch 0
      evs.push({ tick: t + noteDur, ord: 0, bytes: [0x80, it, 0x00] });  // note off, ch 0
    }
    t += PPQ;                              // one beat (quarter note) per slot, incl. rests
  });
  evs.sort((a, b) => a.tick - b.tick || a.ord - b.ord);   // note-off before note-on at a shared tick
  const us = Math.round(60000000 / bpm);   // microseconds per quarter note
  let data = [].concat(vlq(0), [0xFF, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
  let prev = 0;
  evs.forEach(e => { data = data.concat(vlq(e.tick - prev), e.bytes); prev = e.tick; });
  data = data.concat(vlq(Math.max(0, t - prev)), [0xFF, 0x2F, 0x00]);    // end of track
  const head = sbytes('MThd').concat(u32(6), u16(0), u16(1), u16(PPQ));  // format 0, 1 track
  const trk = sbytes('MTrk').concat(u32(data.length), data);
  return new Uint8Array(head.concat(trk));
}
/* Download name: first few pitches + a local timestamp, so exports
   identify at a glance and sort chronologically
   (melody-C4-Ds4-E4-20260706-174512.mid). '#' is spelled 's' — a '#'
   would truncate the name anywhere it travels through a URL. */
export function midiFileName(seq, d) {
  const pad = n => String(n).padStart(2, '0');
  d = d || new Date();
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const lead = seq.filter(x => x !== 'R').slice(0, 3).map(m => noteName(m).replace('#', 's'));
  return 'melody-' + lead.join('-') + '-' + stamp + '.mid';
}

/* ── MIDI import ──
   Parses a Standard MIDI File fully in-memory and rebuilds a sequence
   from it. The model is a plain run of equal one-beat slots, so the file
   is flattened to fit: all tracks merge, chords collapse to their top
   note (skyline melody), and note starts snap to the coarsest grid that
   fits every inter-note gap — one grid step per slot, with rests filling
   the gaps and the file's tempo mapped onto the BPM. A file saved by
   buildMidi() round-trips exactly. Malformed or unsupported input throws
   Error('midi') — the parser refuses rather than guessing. */
export const MAX_IMPORT = 1000;            // slot cap — over-long files are rejected, never silently trimmed
export function parseMidi(buf) {
  const u8 = new Uint8Array(buf);
  let p = 0;
  const die = () => { throw new Error('midi'); };
  const need = n => { if (p + n > u8.length) die(); };
  const rd32 = () => { need(4); return (((u8[p++] << 24) | (u8[p++] << 16) | (u8[p++] << 8) | u8[p++]) >>> 0); };
  const rd16 = () => { need(2); return (u8[p++] << 8) | u8[p++]; };
  const tag  = () => { need(4); const s = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]); p += 4; return s; };
  if (tag() !== 'MThd') die();
  const hlen = rd32(); if (hlen < 6) die();
  const hEnd = p + hlen;
  if (hEnd > u8.length) die();             // header claims more bytes than the file holds
  const fmt = rd16();
  if (fmt !== 0 && fmt !== 1) die();       // only format 0 (single track) and 1 (synchronous); 2 would lie on merge, 3+ isn't SMF
  const ntrk = rd16(), div = rd16();
  if (div & 0x8000) die();                 // SMPTE timing — vanishingly rare, unsupported
  if (ntrk < 1 || (fmt === 0 && ntrk !== 1)) die();  // format 0 is exactly one track by definition
  const ppq = div || 480;
  p = hEnd;
  const notes = []; let tempo = 0, eot = 0;
  let seen = 0;
  for (; seen < ntrk && p + 8 <= u8.length; ) {
    const id = tag(), len = rd32();
    if (p + len > u8.length) die();        // truncated chunk — refuse, don't import a partial melody
    const end = p + len;
    if (id !== 'MTrk') { p = end; continue; }   // alien chunk — skip per the spec, doesn't use up a track slot
    seen++;
    let tick = 0, status = 0;
    const vlqr = () => {                   // ≤4 bytes per the spec — reject overlong encodings
      let v = 0, b, n = 0;
      do { if (p >= end || ++n > 4) die(); b = u8[p++]; v = v * 128 + (b & 0x7f); } while (b & 0x80);
      return v;
    };
    while (p < end) {
      tick += vlqr();
      if (p >= end) die();
      if (u8[p] & 0x80) status = u8[p++];
      if (status === 0xFF) {               // meta event
        if (p >= end) die();
        const type = u8[p++], mlen = vlqr();
        if (p + mlen > end) die();
        if (type === 0x51 && mlen === 3 && !tempo) tempo = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
        p += mlen;
        if (type === 0x2F) break;          // end of track
        status = 0;                        // meta cancels running status
      } else if (status === 0xF0 || status === 0xF7) {
        const slen = vlqr();               // sysex — skip payload
        if (p + slen > end) die();
        p += slen;
        status = 0;
      } else if (status >= 0x80 && status <= 0xEF) {   // channel message
        const kind = status & 0xF0, two = !(kind === 0xC0 || kind === 0xD0);
        if (p + (two ? 2 : 1) > end) die();
        const d1 = u8[p++], d2 = two ? u8[p++] : 0;
        if ((d1 | d2) & 0x80) die();       // status byte in a data slot — stream is desynced
        if (kind === 0x90 && d2 > 0 && (status & 0x0F) !== 9) notes.push({ tick, m: d1 }); // skip ch10 percussion
      } else die();                        // 0xF1-0xFE, or a data byte with no running status
    }
    if (tick > eot) eot = tick;            // end-of-track tick — preserves trailing rests
    p = end;
  }
  if (seen !== ntrk) die();               // declared tracks must all be present — a truncated file would drop notes silently
  if (!notes.length) die();
  return { ppq, tempo: tempo || 500000, notes, eot };
}
export function midiToMelody(mid) {
  const { ppq, tempo, notes, eot } = mid;
  notes.sort((a, b) => a.tick - b.tick || b.m - a.m);
  const CHORD = Math.max(1, Math.round(ppq / 16));    // near-simultaneous starts = one chord
  const ons = [];
  notes.forEach(n => {
    const last = ons[ons.length - 1];
    if (last && n.tick - last.tick <= CHORD) { if (n.m > last.m) last.m = n.m; }
    else ons.push({ tick: n.tick, m: n.m });
  });
  const gaps = [];
  for (let i = 1; i < ons.length; i++) gaps.push(ons[i].tick - ons[i - 1].tick);
  /* coarsest grid every gap sits on, tried coarse to fine so a triplet
     gap locks onto ppq/3 before a finer straight grid can approximate it;
     tolerance scales with the candidate (strict on fine grids). Falls
     back to the smallest real gap for unquantized playing. */
  let step = 0;
  for (const s of [ppq, ppq / 2, ppq / 3, ppq / 4, ppq / 6, ppq / 8]) {
    if (gaps.every(g => Math.round(g / s) >= 1 && Math.abs(g - Math.round(g / s) * s) <= s / 8)) { step = s; break; }
  }
  if (!step) {
    gaps.forEach(g => { if (g >= ppq / 8 && (!step || g < step)) step = g; });
    step = Math.min(step || ppq, ppq * 4);
  }
  const seq = [];
  const put = v => { if (seq.length >= MAX_IMPORT) throw new Error('midi'); seq.push(v); };
  const rest = n => { for (let r = 0; r < n; r++) put('R'); };
  rest(Math.max(0, Math.round(ons[0].tick / step)));  // leading rests (pickup / silent intro)
  ons.forEach((o, i) => {
    if (i) rest(Math.max(0, Math.round((o.tick - ons[i - 1].tick) / step) - 1));
    let m = o.m;
    while (m < LO_ALL) m += 12;                       // octave-fold into the 88-key range
    while (m > HI_ALL) m -= 12;
    put(m);
  });
  // trailing rests: the last note occupies one slot, the rest of the
  // distance to end-of-track is silence
  rest(Math.max(0, Math.round((eot - ons[ons.length - 1].tick) / step) - 1));
  const bpm = Math.round(60000000 / tempo * ppq / step);
  return { seq, bpm: Math.max(40, Math.min(240, bpm)) };
}
