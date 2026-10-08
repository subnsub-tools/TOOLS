# Calendar context

The facts a date carries on its own — its ISO week and place in the year,
the Moon's phases, the equinoxes and solstices, the daylight-saving switches
of a time zone — and which entries of a public-holiday feed are actually days
off. This is the logic the Calendar tab on [subnsub.com](https://subnsub.com)
lays over its grid and lists under "At a glance", published so the dates and
instants it shows are auditable.

The grid itself, recurring events and plan sync are not part of this module.

## Files

- [`calendar-context.js`](calendar-context.js) — the module
- [`demo.html`](demo.html) — minimal standalone page: one month's digest,
  the Moon on a chosen day, and a holiday feed folded into runs (runs fully
  offline)

## Usage

```js
import {
  isoWeek, dayOfYear, daysInYear, moonPhaseTimes, moonState, phaseOfDay,
  seasonTimes, clockChanges, zoneOffset, classifyHolidays, holidayItems,
  monthDigest,
} from './calendar-context.js';

isoWeek(2027, 0, 1);              // → { year: 2026, week: 53 }   (months are 0-11)
dayOfYear(2026, 9, 26);           // → 299

moonPhaseTimes(Date.parse('2026-10-01Z'), Date.parse('2026-11-01Z'));
// → [{ phase: 3, ms }, { phase: 0, ms }, { phase: 1, ms }, { phase: 2, ms }]
//   0 new · 1 first quarter · 2 full · 3 last quarter, instants in UTC ms

moonState(Date.now());            // → { illum: 0.78, elong: 121.4, waxing: true, phase8: 3 }
phaseOfDay(null, moonState(noon)); // the day's name: crescent or gibbous unless a
                                   // principal phase falls that day (pass it instead of null)

seasonTimes(2026);                // → [{ kind: 0, ms }, … ]  March equinox … December solstice

clockChanges(from, to, 'Europe/Berlin');
// → [{ ms, before: 120, after: 60, delta: -60 }]   offsets in minutes east of UTC

monthDigest(2026, 9, 'Asia/Shanghai');
// → { weeks: [40, 44], days: 31, moon: [...], seasons: [...], clocks: [...] }
//   every item carries k: 'YYYY-MM-DD', its date in that zone
```

Holiday feeds, from raw parsed events to what a reader means by "the
holidays":

```js
classifyHolidays(events);   // sets ev.hk on each { desc } — see below
holidayItems(instances, '2026-09-01', '2026-12-31');
// instances: [{ k: 'YYYY-MM-DD', n: days, t: title, hk }]
// → [{ k: '2026-10-01', end: '2026-10-07', n: 7, titles: ['国庆节'], kind: 'p' }, …]
```

## Model and boundaries

- **Astronomy** follows Jean Meeus, *Astronomical Algorithms* (2nd ed.):
  chapter 49 for the principal phases, chapter 27 for the equinoxes and
  solstices (checked against the published instants of 2024–2026: phases
  within four minutes, equinoxes and solstices within three), chapter 47–48
  for the illuminated fraction. Terrestrial Time is
  converted to UT with the Espenak–Meeus ΔT polynomials. `seasonTimes()` is
  empty outside 1000–3000, where its polynomials stop holding.
- Equinoxes and solstices are named by **month**, not season: the same
  instant starts spring in one hemisphere and autumn in the other.
- `moonState().phase8` names the phase by elongation, so the day before a
  new moon can read as "new". A calendar day should use `phaseOfDay()`:
  a principal name only on the day its instant falls in, crescent or gibbous
  otherwise. The site draws the lit side on the right while waxing — the
  northern-hemisphere view.
- `clockChanges()` samples the zone every six hours and bisects to the
  second, so two switches less than six hours apart would read as one. No
  zone does that.
- **Holiday kinds.** Google's public-holiday calendars write the kind of each
  day into `DESCRIPTION`, in the feed's language ("Public holiday" /
  "Observance", "公众假期" / "节假日", "祝日" / "祭日", "Gesetzlicher
  Feiertag" / "Gedenktag" …). Two things hold in every language checked —
  en, zh, zh-TW, ja, ko, de, fr, es, pt, ru, hi: an observance's
  description has a second line on how to hide observances in Google
  Calendar, which names Google, and a holiday's never does; the national
  holiday is the most common first line among the rest, so any other first
  line is regional. A holiday with a note under it is part of a day. Kinds:
  `p` public · `h` part of a day · `r` regional · `o` observance. An event
  with no description at all reads as public.
- On the site, `classifyHolidays()` runs on the server that fetches the feed
  (the description is read for holiday feeds only, and dropped before the
  response); the browser receives each event with its `hk` already set.
- `holidayItems()` folds consecutive public days into one run (China's
  国庆节 + six days of 黄金周 (国庆节) is one seven-day item), keeps partial
  and regional days on their own, and leaves observances out — they are on
  the grid, but nobody gets them off. Titles that only repeat another title
  in brackets are folded into it. **Weekends are not added to a run**: the
  feeds do not list the make-up working days some countries trade for long
  breaks, so whether the adjoining weekend is off is not something the feed
  can tell.
- No DOM, no storage, no network.
