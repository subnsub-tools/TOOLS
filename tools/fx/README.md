# Currency Converter (FX)

USD-base cross-rate math, tolerant amount parsing, adaptive number formatting
and the saved-pairs model — the logic of the Currency tab on
[subnsub.com](https://subnsub.com), published so the "conversion runs entirely
in your browser" claim is auditable. The page only ever downloads a rate
table; the amounts you type are never sent anywhere.

## Files

- [`fx-convert.js`](fx-convert.js) — the module: payload reading, cross-rate
  math, amount parsing/formatting, code lists & search, saved-pairs model,
  and the history layer (pair points, day/range moves, the chart path, the
  majors rows and the ladders)
- [`demo.html`](demo.html) — minimal standalone page exercising the module
  against a bundled sample payload (runs fully offline)

## Usage

```js
import {
  readRatesPayload, mergeNames, parseAmount, crossRate, convert,
  fmtMoney, fmtRate, quickTargets,
} from './fx-convert.js';

// The page — not the module — fetches the rate document:
const payload = await (await fetch('/api/rates')).json();

const doc = readRatesPayload(payload);           // { rates, date, names } | null
const names = mergeNames(doc.names);             // builtin English names + fetched map

const amt = parseAmount('1 234,50');             // grouping/decimal tolerant → 1234.5
const rate = crossRate(doc.rates, 'usd', 'eur'); // 1 USD = rate EUR (NaN when unknown)
const out = convert(doc.rates, 'usd', 'eur', amt);
fmtMoney(out, 'en');                             // adaptive precision, '—' for NaN

crossRate(doc.rates, 'eur', 'usd');              // the inverse: 1 EUR = … USD
quickTargets(doc.rates, 'usd');                  // 8 popular tile targets ≠ 'usd'
```

### History (the pair over time)

```js
import {
  historyRequest, readHistoryPayload, pairPoints, dayPair, pctChange,
  rangeStats, moveOf, fmtPct, fmtDelta, sparkPath, nearestIndex,
  majorRows, ladderRows,
} from './fx-convert.js';

// The page asks for what the module says to ask for — the module never fetches:
const ask = historyRequest('1m', 'usd', 'eur');          // { range:'1m', codes:[…majors + pair] }
const raw = await (await fetch('/api/rates-history?range=' + ask.range + '&codes=' + ask.codes.join(','))).json();
const hist = readHistoryPayload(raw);                     // { dates, series } | null

// FROM→TO on each sampled day, the live table laid over the newest point:
const pts = pairPoints(hist, 'usd', 'eur', doc.rates, doc.date); // [[iso, rate], …]
const day = dayPair(pts);                                  // [before, last] or null
const move = day ? pctChange(day[0], day[1]) : NaN;        // the day's move
const st = rangeStats(pts);                                // { high, highDate, low, lowDate, avg, change, pct, … }
fmtDelta(st.change, 'en') + ' (' + fmtPct(st.pct, 'en') + ')'; // '+0.0123 (+1.37%)'
moveOf(st.pct);                                            // 'up' | 'down' | 'flat' → a CSS class

const { d, xs } = sparkPath(pts, 600, 150);                // SVG path + each point's x
nearestIndex(xs, pointerX);                                // which day the pointer is over

majorRows('usd', 'thb');                                   // the majors against FROM, TO leading
ladderRows(doc.rates, 'jpy', 'usd');                       // [[100, 0.67], [500, 3.33], …]
```

## `/api/rates` payload contract

The site keeps its no-third-party-requests promise by proxying the public
open-data currency table (the fawazahmed0 *currency-api* dataset) through its
own origin, server-side. `GET /api/rates` (same-origin) returns:

```
200 → {
  ok:    true,
  base:  "usd",
  date:  "YYYY-MM-DD" | null,           // date of the rate set
  rates: { "<code>": unitsPerUSD, … },  // lowercase currency codes
  names: { "<code>": "Name", … }        // English display names
}
502 → { ok: false, error: "rates_unavailable" }
```

`readRatesPayload()` consumes the decoded JSON; the module itself never
fetches. A `names` map with 20 entries or fewer is discarded as
truncated/garbage rather than allowed to shadow the builtin name set.

## `/api/rates-history` payload contract

The same open daily tables, sampled server-side across a range — how many
units of each asked currency one US dollar bought on a handful of days.
`GET /api/rates-history?range=1m|3m|1y&codes=usd,cny,…` (same-origin) returns:

```
200 → {
  ok:     true,
  range:  "1m" | "3m" | "1y",
  dates:  ["YYYY-MM-DD", …],             // ascending; 1m every day, 3m every 3rd, 1y every 14th
  series: { "<code>": [unitsPerUSD | null, …] }   // one entry per date; codes the tables
}                                                  // lack are simply left out
4xx/5xx → { ok: false, error: "invalid_query" | "rates_unavailable" }
```

`readHistoryPayload()` validates it (fewer than two dated points is no
history); `historyRequest()` says which codes to ask for — the month's table
carries the majors and the pair in one request, a quarter or a year is asked
for the pair alone. Only a code's shape (`/^[a-z0-9]{2,12}$/`) is ever put in
a request.

## Model & notes

- **One USD-base table serves every pair**: `FROM→TO = rateOf(to) / rateOf(from)`
  with `rateOf('usd') ≡ 1`. An unknown or non-positive rate makes the cross
  rate `NaN` — rendered as an em-dash, never as a zero that could pass for a
  price.
- **Amount parsing** drops spaces/apostrophes (grouping separators) and
  treats a single comma as the decimal point only when no dot is present:
  `"1,5"` → 1.5, `"1,234.5"` → 1234.5.
- **Formatting precision adapts to magnitude** so sub-unit results (e.g. a
  BTC conversion) aren't flattened to `0.00`; `rawString()` gives a
  paste-friendly plain number for copy actions.
- **Saved pairs**: at most 8, deduped per direction (`usd>eur` and `eur>usd`
  are distinct), same-currency pairs rejected, amounts bounded to
  [1e-6, 1e12) and canonicalized to ≤6 decimals. The serialized shape is
  `[{ f, t, a }, …]`; `sanitizeFavs()` / `serializeFavs()` round-trip it, and
  the site's sync layer applies the same validation so a synced list arrives
  exactly as saved. `upsertFav()` updates the amount in place when the pair
  already exists, so a full list never traps you into remove-then-re-add.
- **History**: a pair's rate on a day is `TO's units / FROM's units`, as
  the live cross rate; the base is 1 on every day. `pairPoints()` lays the
  live table over the newest point (or after it when the table is newer),
  so a chart always ends on the number the converter shows. The day's move
  (`dayPair()`) needs a point dated exactly one day before the last — over a
  day the tables are missing, a two-day move is not a 1D. Moves under half
  a basis point read as `flat`.
- **Chart model**: `sparkPath()` places x by date (a sparser range keeps its
  time axis straight) and y with 8% headroom; a flat series gets a 2% band
  so it still draws. The page wraps the path in its own SVG and hover/
  keyboard readout; `nearestIndex()` is the lookup behind both.
- **Ladders**: eight round sums of one currency in the other, scaled by the
  first currency's worth against the dollar (100 yen, 0.00001 BTC), so the
  first row is about a dollar's worth.
- Site-only layers are not part of this module: the fetch/refresh cycle and
  the last-good-rates offline cache, the history cache and its half-hour
  TTL / one-minute failure backoff, the status dot, the pickers' DOM, the
  chart's SVG/pointer/keyboard wiring, and i18n.
