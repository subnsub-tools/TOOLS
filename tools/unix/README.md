# Unix Timestamp

Unix epoch seconds ↔ human-readable dates — the core logic of the Unix
tab on [subnsub.com](https://subnsub.com), published so the conversion
math and formatting the site applies are auditable.

## Files

- [`unix-time.js`](unix-time.js) — the module: `timestampToDate()`,
  `dateToTimestamp()`, `describeTimestamp()`, `relTime()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { timestampToDate, dateToTimestamp, describeTimestamp, relTime }
  from './unix-time.js';

timestampToDate('1714363200');    // '2024-04-29 04:00:00.000 UTC'
timestampToDate('1714363200.5');  // '2024-04-29 04:00:00.500 UTC'
timestampToDate('junk');          // null

dateToTimestamp('2024-04-29T04:00:00Z');  // 1714363200
dateToTimestamp('2024-04-29T04:00');      // read in the *local* zone
                                          // (the tab feeds a datetime-local value)

describeTimestamp(1714363200);
// { utc: 'Mon, 29 Apr 2024 04:00:00 GMT',
//   local: '4/29/2024, 4:00:00 AM',        ← locale/zone dependent
//   rel: '805d ago' }                      ← relative to now

relTime(-42);     // '42s ago'
relTime(7200);    // 'in 2h'
```

## Notes

- Timestamps are epoch **seconds** (the Unix convention); the
  ×1000/÷1000 against JavaScript's millisecond dates happens inside the
  module. Fractional and negative (pre-1970) seconds are fine.
- Formatting leans on the platform deliberately — `toISOString`,
  `toUTCString`, `toLocaleString` — so output matches what the runtime
  itself considers correct for the viewer's locale and zone.
- Boundaries are the platform's too: `timestampToDate` accepts whatever
  `Number()` accepts and returns `null` for empty or non-numeric input;
  `dateToTimestamp` accepts whatever the `Date` constructor parses and
  returns `null` otherwise; timestamps beyond the ECMAScript `Date`
  range (±8.64e15 ms) throw a `RangeError` from `toISOString`.
- `describeTimestamp`'s `rel` string is relative to the moment of the
  call — the tab re-renders it every second.
