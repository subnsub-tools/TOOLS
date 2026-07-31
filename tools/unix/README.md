# Unix Timestamp

Unix epoch timestamps ↔ human-readable dates — the logic of the Unix
tab on [subnsub.com](https://subnsub.com), published so the conversion
math and formatting the site applies are auditable.

## Files

- [`unix-time.js`](unix-time.js) — the module: `unixParse()`,
  `unixFormatZone()`, `unixRelative()`, `unixDateFromParts()`,
  `unixZoneOk()`
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
