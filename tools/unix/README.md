# Unix Timestamp

Unix epoch timestamps ↔ human-readable dates — the logic of the Unix
tab on [subnsub.com](https://subnsub.com), published so the conversion
math and formatting the site applies are auditable.

## Files

- [`unix-time.js`](unix-time.js) — the module: `unixParse()`,
  `unixFormatUtc8()`, `unixRelative()`, `unixDateFromParts()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { unixParse, unixFormatUtc8, unixRelative, unixDateFromParts }
  from './unix-time.js';

// One entry point for every form — it works out which one you handed it.
unixParse('1714363200');      // 1714363200000  ← epoch seconds
unixParse('1714363200000');   // 1714363200000  ← epoch milliseconds
unixParse('1714363200.5');    // 1714363200500  ← fractional seconds
unixParse('2026-06-08');      // 1780848000000  ← read as UTC+8
unixParse('2026/06/08 14:30');// 1780900200000
unixParse('20260608');        // 1780848000000  ← a date, it spells one
unixParse('12345678');        // 12345678000    ← not a date, so seconds
unixParse('2026年6月8日');     // 1780848000000
unixParse('2026-06-08T14:30:00+02:00'); // 1780921800000 ← keeps its offset
unixParse('2026-02-30');      // null  ← matched a date grammar, impossible
unixParse('not a date');      // null

unixFormatUtc8(1714363200000);   // '2024-04-29 12:00:00'
unixFormatUtc8(NaN);             // null

unixRelative(Date.now() + 7.2e6);         // 'in 2 hours'
unixRelative(Date.now() - 3 * 864e5);     // '3 days ago'
unixRelative(Date.now() - 3 * 864e5, 'zh-CN'); // '3天前'

// [year, month, day, hour, minute, second, millis] read as UTC+8
unixDateFromParts([2026, 6, 8]);      // 1780848000000
unixDateFromParts([2026, 2, 30]);     // null — no such day
```

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
- **Output is UTC+8, on purpose.** Reading a zoneless date in the
  viewer's own zone would make one input mean different instants on
  different machines — no good when two people are comparing a
  timestamp. A string that carries an explicit offset (`Z`, `+02:00`,
  `GMT`) keeps its own and is converted for display.
- **Impossible dates are rejected, not rolled over.** `2026-02-30`
  returns `null` rather than becoming 2 March: every parsed date is
  round-tripped through `Date` and the fields must come back unchanged.
- Negative (pre-1970) and fractional values are fine. Anything beyond
  the ECMAScript `Date` range (±8.64e15 ms) returns `null` rather than
  throwing.
- `unixRelative` picks the largest unit that fits (second, minute, hour,
  day) and formats it with `Intl.RelativeTimeFormat`; pass a locale as
  the second argument, or leave it out for the runtime default. Its
  output is relative to the moment of the call — the tab re-renders it
  every second.
