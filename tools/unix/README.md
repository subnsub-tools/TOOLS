# Unix Timestamp

Unix epoch timestamps ↔ human-readable dates — the logic of the Unix
tab on [subnsub.com](https://subnsub.com), published so the conversion
math and formatting the site applies are auditable.

## Files

- [`unix-time.js`](unix-time.js) — the module: `unixParse()`,
  `unixFormatZone()`, `unixRelative()`, `unixDateFromParts()`,
  `unixZoneOk()`, and the instant every other way — `unixFormats()`,
  `unixDateInfo()`, `unixMilestones()`, `unixOffsetMin()` / `unixOffsetStr()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Zones

Every function that touches a wall clock takes a `zone`:

| `zone` | meaning |
|---|---|
| `''` | the running device's own zone, DST included — the tab's default |
| an IANA name | `'UTC'`, `'America/New_York'`, … handed to `Intl` |

An epoch number means the same instant in every zone. The zone decides
how a *zoneless* date is **read** and how a result is **shown**; a string
carrying its own offset (`Z`, `+02:00`, `GMT`) always keeps it.

`Intl` throws a `RangeError` on a zone name its data does not know, and
every function here would carry that up to you. If the zone comes from
anywhere untrusted — a stored preference, a query string, a text field —
check it first:

```js
unixZoneOk('');              // true  — the device's own zone
unixZoneOk('America/New_York');  // true
unixZoneOk('Mars/Olympus');      // false
```

## Usage

```js
import { unixParse, unixFormatZone, unixRelative, unixDateFromParts }
  from './unix-time.js';

// One entry point for every form — it works out which one you handed it.
// Epoch input is zone-independent, so '' vs anything else changes nothing:
unixParse('1714363200', '');    // 1714363200000  ← epoch seconds
unixParse('1714363200000', ''); // 1714363200000  ← epoch milliseconds
unixParse('1714363200.5', '');  // 1714363200500  ← fractional seconds
unixParse('12345678', '');      // 12345678000    ← not a date, so seconds
unixParse('not a date', '');    // null

// A zoneless date IS read in the zone (these assume '' resolves to UTC):
unixParse('2026-06-08', 'UTC');               // 1780876800000
unixParse('2026-06-08', 'Asia/Shanghai');     // 1780848000000
unixParse('2026-06-08', 'America/New_York');  // 1780891200000
unixParse('20260608', 'UTC');    // 1780876800000  ← a date, it spells one
unixParse('2026年6月8日', 'UTC'); // 1780876800000
unixParse('2026-02-30', 'UTC');  // null  ← matched a date grammar, impossible
// …but an epoch value, or a string with its own offset, ignores it.
unixParse('1714363200', 'UTC') === unixParse('1714363200', 'Asia/Tokyo');   // true
unixParse('2026-06-08T14:30:00+02:00', 'UTC'); // 1780921800000
// An hour a spring-forward skips does not exist:
unixParse('2026-03-08 02:30', 'America/New_York'); // null

unixFormatZone(1714363200000, 'UTC');               // '2024-04-29 04:00:00'
unixFormatZone(1714363200000, 'Asia/Shanghai');     // '2024-04-29 12:00:00'
unixFormatZone(1714363200000, 'America/New_York');  // '2024-04-29 00:00:00'
unixFormatZone(1714363200000, 'Asia/Kathmandu');    // '2024-04-29 09:45:00'
unixFormatZone(NaN, 'UTC');                         // null
// A legal ±8.64e15 instant can shift out of the Date range in some zones:
unixFormatZone(8640000000000000, 'Asia/Tokyo');     // null

unixRelative(Date.now() + 7.2e6);              // 'in 2 hours'
unixRelative(Date.now() - 3 * 864e5);          // '3 days ago'
unixRelative(Date.now() - 3 * 864e5, 'zh-CN'); // '3天前'

// [year, month, day, hour, minute, second, millis] read in `zone`
unixDateFromParts([2026, 6, 8], 'UTC');            // 1780876800000
unixDateFromParts([2026, 6, 8], 'Asia/Shanghai');  // 1780848000000
unixDateFromParts([2026, 2, 30], 'UTC');           // null — no such day
```

### One instant, every other way

```js
import { unixFormats, unixDateInfo, unixMilestones, unixOffsetMin, unixOffsetStr }
  from './unix-time.js';

unixOffsetStr(unixOffsetMin(1714363200000, 'Asia/Kolkata'));  // 'UTC+05:30'

unixFormats(1714363200000, 'Europe/Berlin');
// [['iso', 'ISO 8601', '2024-04-29T06:00:00+02:00'],
//  ['rfc2822', 'RFC 2822', 'Mon, 29 Apr 2024 06:00:00 +0200'],
//  ['utc', 'RFC 3339, UTC', '2024-04-29T04:00:00.000Z'],
//  ['us', …], ['ns', …],                       // micro- and nanoseconds
//  ['filetime', 'Windows FILETIME', '133588368000000000'],
//  ['ticks', '.NET ticks', '638499600000000000'],
//  ['excel', 'Excel serial date', '45411.25'], // the zone's wall clock
//  ['ntp', …], ['gps', …], ['jd', …], ['cocoa', …], ['webkit', …], ['hex', …]]

unixDateInfo(1714363200000, 'Europe/Berlin');
// { weekday: 1, iso: { year: 2024, week: 18 }, doy: 120, days: 366, quarter: 2,
//   dst: true, next: { ms: 1729990800000, delta: -60 } }   // 27 Oct, back an hour

unixMilestones(Date.now());
// [{ sec: 1800000000, kind: 'round' }, …, { sec: 2147483647, kind: 'i32' },
//  { sec: 4294967295, kind: 'u32' }]
```

- A format that cannot hold the instant gives `null` instead of a wrong
  number: FILETIME and WebKit before 1601, .NET ticks before year 1, Excel
  before its day 1 (1 January 1900), NTP before 1900, GPS before 1980-01-06.
  Excel's 1900 system counts a 29 February 1900 that never was, so its
  serials run one ahead of the days elapsed from 1 March 1900 on (1900-02-28
  is 59, 1900-03-01 is 61) and not before.
- **GPS time does not stop for leap seconds**, so it runs ahead of UTC by
  every leap second since 1980 — 18 since 2017; the table is in the module.
  Excel serial dates and ISO/RFC strings follow the zone's wall clock; the
  epoch counts (µs, ns, FILETIME, ticks, NTP, Cocoa, WebKit, hex) do not.
  The big counts are `BigInt` strings, past what a double holds exactly.
- `unixDateInfo().dst` is `null` in a zone whose offset does not change
  from half a year before the instant to a year after it, else whether the
  offset at the instant stands above the lowest within half a year either
  side. The offset is sampled every two days rather than in January and
  July — Morocco keeps the same offset at both and changes around Ramadan.
  `next` is the next switch within a year, bisected on whole minutes.

## Notes

- **Milliseconds are the unit.** `unixParse` always returns epoch
  milliseconds; divide by 1000 yourself if you want seconds. Input may
  be either — a bare number is read as seconds up to 11 digits and as
  milliseconds beyond, a threshold far past any plausible
  second-precision date.
- **An unpunctuated digit run is checked as a date first.** `20260608`
  and `20260608143000` spell real calendar dates, so they are read as
  such; `12345678` and `10000000000000` do not, so they stay epoch
  values. Anything carrying separators is only ever a date.
- **Impossible instants are rejected, not rolled over.** `2026-02-30`
  returns `null` rather than becoming 2 March, and so does an hour that
  a DST spring-forward skips: every parsed date is round-tripped through
  its zone and the fields must come back unchanged.
- Negative (pre-1970) and fractional values are fine. Anything beyond
  the ECMAScript `Date` range (±8.64e15 ms) returns `null` rather than
  throwing.
- `unixRelative` picks the largest unit that fits (second, minute, hour,
  day) and formats it with `Intl.RelativeTimeFormat`; pass a locale as
  the second argument, or leave it out for the runtime default. Its
  output is relative to the moment of the call — the tab re-renders it
  every second. It takes no zone: an elapsed span is the same everywhere.
