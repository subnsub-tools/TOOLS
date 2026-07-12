# Currency Converter (FX)

USD-base cross-rate math, tolerant amount parsing, adaptive number formatting
and the saved-pairs model — the core logic of the Currency tab on
[subnsub.com](https://subnsub.com), published so the "conversion runs entirely
in your browser" claim is auditable. The page only ever downloads a rate
table; the amounts you type are never sent anywhere.

## Files

- [`fx-convert.js`](fx-convert.js) — the module: payload reading, cross-rate
  math, amount parsing/formatting, code lists & search, saved-pairs model
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

quickTargets(doc.rates, 'usd');                  // 8 popular tile targets ≠ 'usd'
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
- Site-only layers are not part of this module: the fetch/refresh cycle and
  the last-good-rates offline cache, the status dot, the pickers' DOM, and
  i18n.
