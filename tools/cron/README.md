# Cron Expression

Parse classic 5-field cron expressions into plain language and compute the
next execution times, entirely client-side. This is the core logic of the
[Cron Expression tab on subnsub.com](https://subnsub.com), published so the
schedule math the tool shows you is auditable.

## Files

- [`cron-parse.js`](cron-parse.js) — the module: `cronExpand()`,
  `cronDescribe()`, `cronNext()`, `cronRelative()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { cronDescribe, cronNext, cronExpand, cronRelative } from './cron-parse.js';

cronDescribe('0 9 * * 1-5');
// → 'At 09:00, on Mon, Tue, Wed, Thu, Fri'   (null if not 5 fields)

cronNext('*/15 * * * *', 5);
// → [Date, Date, Date, Date, Date] — next 5 fire times in local time

cronNext('0 0 1 * *', 10, new Date('2026-07-01T12:00:00'));
// third argument pins the "from" clock (defaults to new Date())

cronExpand('9-17/2', 0, 23);      // → [9, 11, 13, 15, 17]
cronExpand('5-1', 0, 6, 7);       // wrap-around DOW range → [0, 1, 5, 6]

cronRelative(fireDate);           // → 'in 12m' (optional now-ms 2nd arg)
```

## Model and boundaries

- Field order `minute hour day-of-month month day-of-week`; each field
  accepts `*`, values, `a-b` ranges, `a,b,c` lists and `/n` steps, in
  combination. Day-of-week is 0–6 with `7` folding onto Sunday, and
  wrap-around ranges (`5-1`) cross the week boundary.
- When both day-of-month **and** day-of-week are restricted, the standard
  POSIX/Vixie OR rule applies: either match fires.
- `cronNext()` walks the local wall clock minute by minute (skipping whole
  days/hours a coarser field rules out), so results land where a real
  crontab would across DST changes. Impossible schedules (`0 0 31 2 *`)
  return fewer or zero results after a one-year search bound instead of
  hanging.
- Numbers only — no seconds field, no `@daily` macros, no `L`/`W`/`#`
  extensions, no `JAN`/`MON` names. Malformed parts of a field are
  ignored rather than thrown; a field that expands to nothing simply never
  matches.
- Descriptions favour recognisable phrasings (`every 15 minutes`,
  `at 09:00, 17:30`) and fall back to a literal
  `minute {m} of hour {h}` form when the time pattern is too dense to
  enumerate.
