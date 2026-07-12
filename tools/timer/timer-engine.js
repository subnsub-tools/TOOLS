/* Countdown / stopwatch / clock engines — the timekeeping core of the
   Timer tab on subnsub.com, kept in lockstep with the in-page version.
   (That tab's other widgets — pomodoro, alarms, world clock, day counter —
   are UI built around these same primitives and stay on the site.)

   Time model (identical to the site's shared requestAnimationFrame loop):
   - The host drives every engine with tick(now), where `now` is a
     performance.now()-style monotonic millisecond stamp. On the site one
     rAF loop ticks all widgets each frame.
   - Every tick advances the engine's time base unconditionally:
     dt = (now - lastTick) / 1000, then lastTick = now. A paused countdown
     or a stopped stopwatch consumes the frame WITHOUT counting it — so the
     host must keep ticking through pauses. That is what makes pause/resume
     drift-free: the paused span is discarded frame by frame, and resuming
     needs no re-anchoring.
   - A backgrounded tab parks rAF; the first tick after it returns carries
     the whole absence as one large dt. A running countdown catches up in
     one step (and finishes immediately if it ran out while hidden), a
     running stopwatch jumps forward by the real elapsed time, and a paused
     one discards it. This catch-up is deliberate: the engines follow the
     wall clock, not the frame count.
   - start() and toggle() re-anchor lastTick to their own `now`, so time
     from before the gesture is never counted into the fresh run.

   No DOM, no storage, no timers of its own: rendering (the progress ring,
   the second-hand arc, label swaps) and persistence stay with the caller.
   Clock formatting is Intl all the way down — an invalid time zone falls
   back to the system clock and an invalid locale to the runtime default,
   exactly as on the site. */

/* m:ss for countdown read-outs (input is whole seconds at the call sites;
   the round + floor keep a fractional input honest anyway) */
export function fmtMS(s) {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* m:ss.d for the stopwatch — tenths, truncated (a stopwatch never shows
   time that has not happened yet) */
export function fmtSW(el) {
  const m = Math.floor(el / 60);
  const s = Math.floor(el % 60);
  const d = Math.floor((el * 10) % 10);
  return m + ':' + String(s).padStart(2, '0') + '.' + d;
}

/* ── countdown ──
   States: 'idle' | 'run', plus a `finishing` latch inside 'run' (the site
   holds its 0:00 flourish for ~1 s, then calls the equivalent of reset()).
   opts.onFinish fires once, from inside the tick that crosses zero. */
export function createCountdown(opts = {}) {
  let tmState = 'idle';
  let total = 60, remaining = 60, tmPaused = false, finishing = false;
  let lastTick = 0;

  function finish() {
    if (finishing) return;
    finishing = true;
    if (opts.onFinish) opts.onFinish();
  }

  /* Arm and run. `seconds` is the full duration (the site's picker feeds
     whole minutes, 1–99); `now` anchors the time base at the gesture. */
  function start(seconds, now = performance.now()) {
    total = remaining = seconds;
    tmPaused = false; finishing = false;
    lastTick = now;
    tmState = 'run';
  }

  function tick(now) {
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (tmState === 'run' && !finishing) {
      if (!tmPaused) {
        remaining -= dt;
        if (remaining <= 0) { remaining = 0; finish(); }
      }
    }
  }

  /* Pause/resume does NOT touch lastTick — the host keeps ticking, each
     paused frame is discarded above, so resume simply starts counting
     again from the next frame. */
  function togglePause() {
    if (finishing || tmState !== 'run') return;
    tmPaused = !tmPaused;
  }

  /* The Cancel button's guard: only a live, un-finished run can be
     cancelled (the finishing flourish always plays out). */
  function cancel() {
    if (!finishing && tmState === 'run') reset();
  }

  /* Back to idle unconditionally — the site calls this from Cancel and,
     after the ~1 s finishing hold, from finish(). */
  function reset() {
    finishing = false;
    tmState = 'idle';
  }

  /* What the read-out shows: ceil while counting (a 59.2 s remainder still
     reads 1:00), pinned to 0 the moment the run finishes. */
  function displaySeconds() {
    return finishing ? 0 : Math.ceil(remaining);
  }

  /* Elapsed fraction 0..1. The site's ring paints this ×100 as its
     stroke-dashoffset; under 3 minutes it steps by whole seconds instead
     — (1 - displaySeconds()/total) — to tick like a watch hand. */
  function progress() {
    return total > 0 ? 1 - remaining / total : 0;
  }

  return {
    start, tick, togglePause, cancel, reset, displaySeconds, progress,
    running: () => tmState === 'run',
    paused: () => tmPaused,
    finishing: () => finishing,
    remaining: () => remaining,
    total: () => total,
  };
}

/* ── stopwatch ──
   Elapsed accumulates only while running; laps are prepended (newest
   first), each carrying its ordinal, the split since the previous lap,
   and the total at the moment it was taken. */
export function createStopwatch() {
  let swRunning = false, swElapsed = 0, swLaps = [], swLastLap = 0;
  let lastTick = 0;

  /* Start/stop. Re-anchoring lastTick makes the gesture the exact
     boundary: on start, time before the press is not counted; on stop,
     accumulation simply ceases (the anchor is then inert). */
  function toggle(now = performance.now()) {
    swRunning = !swRunning;
    lastTick = now;
  }

  function tick(now) {
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (swRunning) swElapsed += dt;
  }

  /* Lap is only offered while running (stopped, the same button is
     Reset on the site). Returns the recorded entry. */
  function lap() {
    if (!swRunning) return null;
    const n = swLaps.length + 1;
    const split = swElapsed - swLastLap;
    swLastLap = swElapsed;
    const entry = { n, split, total: swElapsed };
    swLaps.unshift(entry);
    return entry;
  }

  /* Reset is only offered once stopped. */
  function reset() {
    if (swRunning) return;
    swElapsed = 0; swLaps = []; swLastLap = 0;
  }

  return {
    toggle, tick, lap, reset,
    running: () => swRunning,
    elapsed: () => swElapsed,
    laps: () => swLaps.slice(),
  };
}

/* ── clock ── */

/* The locale's own 12/24-hour habit — what the site defaults to when the
   user has never toggled the format (the stored preference is the host's
   business). */
export function localeHour12(locale) {
  try {
    return !!new Intl.DateTimeFormat(locale || undefined,
      { hour: 'numeric' }).resolvedOptions().hour12;
  } catch (_) { return false; }
}

export function systemZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch (_) { return 'UTC'; }
}

/* Formatter pair for the clock face.
     opts: { locale   BCP 47 tag; invalid/absent → runtime default
             hour12   boolean; absent → the locale's habit
             timeZone IANA id; invalid/absent → system clock }
   read(date?) → { time: 'h:mm:ss', dayPeriod: 'AM'|''…, date: 'Mon, Jan 5' }
   — dayPeriod is split out via formatToParts so the caller can chip it
   separately no matter where the locale would inline it. The effective
   hour12/timeZone are exposed (timeZone stays null when following the
   system clock). Toggling the format means building a new clock, as the
   site does. */
export function createClock(opts = {}) {
  const ckH12 = opts.hour12 != null ? !!opts.hour12 : localeHour12(opts.locale);
  let ckTz = opts.timeZone || null;
  let ckFmtTime = null, ckFmtDate = null;
  const mk = (lg, tz) => {
    const zone = tz ? { timeZone: tz } : {};
    return [
      new Intl.DateTimeFormat(lg, Object.assign(ckH12
        ? { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }
        : { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, zone)),
      new Intl.DateTimeFormat(lg, Object.assign({ weekday: 'short', month: 'short', day: 'numeric' }, zone)),
    ];
  };
  let lg = opts.locale || undefined;
  try { new Intl.DateTimeFormat(lg); } catch (_) { lg = undefined; }  /* bad lang tag */
  try { [ckFmtTime, ckFmtDate] = mk(lg, ckTz); }
  catch (_) {
    /* stale/invalid zone — fall back to the system clock (the site also
       clears its stored zone preference at this point) */
    ckTz = null;
    [ckFmtTime, ckFmtDate] = mk(lg, null);
  }

  function read(now = new Date()) {
    const parts = ckFmtTime.formatToParts(now);
    const get = ty => { const p = parts.find(x => x.type === ty); return p ? p.value : ''; };
    return {
      time: get('hour') + ':' + get('minute') + ':' + get('second'),
      dayPeriod: get('dayPeriod'),
      date: ckFmtDate.format(now),
    };
  }

  return { read, hour12: ckH12, timeZone: ckTz };
}
