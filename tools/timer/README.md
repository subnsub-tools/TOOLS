# Timer / Stopwatch / Clock

The timekeeping core of the [Timer tab on subnsub.com](https://subnsub.com) —
countdown, stopwatch (with laps) and a 12/24-hour clock, published so the
engines behind the widgets are auditable. Everything visual on that tab
(the morphing pills, the superellipse progress ring, the minute wheel) is
UI around these engines; the tab's other widgets — pomodoro, alarms, world
clock, day counter — are built on the same primitives and stay on the site.

## Files

- [`timer-engine.js`](timer-engine.js) — the module: `createCountdown()`,
  `createStopwatch()`, `createClock()`, plus `fmtMS()`, `fmtSW()`,
  `localeHour12()`, `systemZone()`
- [`demo.html`](demo.html) — minimal standalone page driving all three
  engines from one requestAnimationFrame loop

## Usage

```js
import {
  createCountdown, createStopwatch, createClock,
  fmtMS, fmtSW, localeHour12,
} from './timer-engine.js';

// Countdown — the site's picker feeds whole minutes (1–99) × 60
const cd = createCountdown({ onFinish: () => console.log('ding') });
cd.start(5 * 60);                    // seconds; anchors the time base "now"
cd.togglePause();                    // pause ↔ resume
fmtMS(cd.displaySeconds());          // '5:00' — ceil while counting, 0 when done
cd.progress();                       // elapsed fraction 0..1 (the ring, ×100)
cd.cancel();                         // only a live, un-finished run cancels

// Stopwatch
const sw = createStopwatch();
sw.toggle();                         // start ↔ stop (the gesture is the boundary)
sw.lap();                            // → { n, split, total } — running only
sw.reset();                          // stopped only
fmtSW(sw.elapsed());                 // '0:04.7'

// Drive every engine from one frame loop — including through pauses
function frame(now) {                // now = performance.now()-style stamp
  cd.tick(now);
  sw.tick(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Clock — formatting only; call read() once a second (or per frame)
const clock = createClock({ locale: 'en', hour12: localeHour12('en') });
clock.read();                        // { time: '3:07:42', dayPeriod: 'PM', date: 'Mon, Jul 13' }
```

## Time model — the part that must not drift

- **dt accumulation, not target timestamps.** Each `tick(now)` advances the
  engine by `(now − lastTick) / 1000` and re-anchors `lastTick`
  unconditionally. A paused countdown discards its frames one by one, so
  **the host must keep ticking through pauses** — that is exactly what
  makes resume drift-free without any re-anchoring.
- **Background catch-up.** A hidden tab parks `requestAnimationFrame`; the
  first tick after it returns carries the whole absence as one large `dt`.
  A running countdown catches up in one step (and finishes immediately if
  it ran out while hidden), a running stopwatch jumps forward by the real
  elapsed time, a paused one discards it. The engines follow the wall
  clock, not the frame count.
- **Gestures re-anchor.** `start()` and `toggle()` reset their engine's
  `lastTick`, so time from before the press is never counted into the
  fresh run.
- The countdown holds a `finishing` latch after hitting zero (the site
  shows its 0:00 flourish for about a second, then calls `reset()`);
  `cancel()` and `togglePause()` are gated exactly as the site's buttons
  are.

## Boundaries

- No DOM, no storage, no timers of its own — rendering and persistence
  belong to the caller. On the site, the 12/24-hour choice and the picked
  time zone persist per account; here they are plain constructor options.
- `createClock` is Intl end to end: an invalid `timeZone` falls back to
  the system clock, an invalid `locale` to the runtime default — same
  fallbacks as the site.
