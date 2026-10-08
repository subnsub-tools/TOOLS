# Cron Expression

Parse classic 5-field cron expressions, say what they mean in plain
language, and compute when they run — in any time zone, around clock
changes — entirely client-side. This is the logic of the
[Cron Expression tab on subnsub.com](https://subnsub.com), published so the
schedule math the tool shows you is auditable.

## Files

- [`cron-parse.js`](cron-parse.js) — the module
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import {
  cronParse, cronDescribe, cronRuns, cronNext, cronStats,
  cronRanges, cronZoneOffset, cronRelative, CRON_MACROS, CRON_FIELDS,
} from './cron-parse.js';

cronParse('0 9 * * MON-FRI');
// → { ok: true, fields: { min: [0], hour: [9], dom: [1…31], mon: [1…12], dow: [1,2,3,4,5] },
//     raw: ['0','9','*','*','MON-FRI'], macro: null, domStar: true, dowStar: false }

cronParse('75 * * * *');
// → { ok: false, error: { code: 'range', field: 'min', token: '75' } }

cronDescribe('*/5 9-17 * * *');    // → 'Every 5 minutes, between 09:00 and 17:59'
cronDescribe('0 0 1 * MON');       // → 'At 00:00, on day 1 of the month or on Mon'
cronDescribe('0 0 1-31 * MON');    // → 'At 00:00' — either day may match, and 1–31 is every day
cronDescribe('0 9 * * 1-5', t);    // t(key, english, vars) translates each phrase

cronRuns('30 2 * * *', 3, Date.parse('2026-03-28T12:00Z'), 'Europe/Berlin');
// → [{ ms, wall, gap: true }, { ms, wall }, { ms, wall }]
//   02:30 does not exist on 29 March in Berlin: that run is at the switch

cronRuns('*/30 2 * * *', 4, Date.parse('2026-10-24T12:00Z'), 'Europe/Berlin');
// → 02:00 and 02:30 on 25 October, then both again with again: true —
//   "*" in the minute makes it a wildcard job, which runs by the clock

cronNext('*/15 * * * *', 5);       // → [Date × 5] in this runtime's zone (the earlier API)

cronStats('*/15 9-17 * * 1-5', Date.now(), 'UTC');
// → { runs, perDay, minGap, maxGap, heat: 7×24 counts (weekday 0 = Sunday, hour) }
```

## Model and boundaries

- Field order `minute hour day-of-month month day-of-week`; each field
  accepts `*`, values, `a-b` ranges, `a,b,c` lists and `/n` steps in
  combination. `a/n` reads as "from a to the top, every n" (`5/15` →
  5, 20, 35, 50), as in Vixie cron. Day-of-week is 0–6 with `7` folding
  onto Sunday, and wrap-around weekday ranges (`5-1`) cross the week.
- Months and weekdays also take English names in any case (`JAN-MAR`,
  `mon-fri`). The shortcuts `@yearly` (`@annually`), `@monthly`, `@weekly`,
  `@daily` (`@midnight`) and `@hourly` stand for their five fields.
- **Errors are errors.** `cronParse()` refuses anything it cannot read and
  says which field and which token: `fields` (not five — six or seven is
  usually Quartz with seconds or a year), `token`, `range` (outside the
  field's bounds), `order` (a range that runs backwards), `step` (not a
  whole number from 1), `quartz` (`?`, `L`, `W`, `#`), `reboot` (`@reboot`
  runs at startup and has no schedule) and `macro` (an unknown `@` word).
  Nothing is silently dropped; `cronExpand()`, kept from the earlier API,
  returns `[]` for a field that does not parse.
- **Day matching follows Vixie cron** (cronie and most Linux crons): when
  either day field begins with `*`, a date must match both — a bare `*`
  leaves the other in charge, a stepped one narrows it; when both are
  restricted, a date matches if **either** does. The description says
  which ("… on day 1 of the month **or** on Mon"), and drops both when
  one of them already covers every day (`1-31`).
- **Time zones and clock changes.** `cronRuns()` walks the wall clock of
  the zone it is given (the runtime's own by default) and converts each
  match to an instant. Across a switch, cron (Vixie, cronie) splits jobs
  in two, and so does this:
  - a **wildcard job** — minute or hour field beginning with `*`, which
    includes `@hourly` (`parse.wild`) — simply runs by the new clock:
    nothing for a stretch the clocks skip, and a second pass through a
    repeated hour, reported with `again: true`;
  - a **fixed-time job** — anything else — runs what the clocks skip as
    they move: each such run is reported **at the switch** with
    `gap: true`. A wall time that happens twice runs once, at its first
    occurrence, with `fold: true`.

  Runs come back in time order either way.
  Impossible schedules (`0 0 31 2 *`) return nothing once a bounded search
  is spent; rare ones (`0 0 29 2 *`) still resolve years out.
- `cronStats()` counts the next 30 days (cap 60,000 runs; every minute is
  43,200) and builds the weekday × hour grid over the first 28.
- Descriptions favour recognisable phrasings (`every 15 minutes`,
  `at 09:00, 17:30`, `between 09:00 and 17:59`) and collapse runs of values
  (`Mon–Fri`, `1–5, 9`). `cronDescribe()` takes an optional translator so a
  page can localize every phrase; `cron.sep` joins them.
- Pure computation: no DOM, no network, no storage.
