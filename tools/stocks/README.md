# Stock Quotes

Quote-payload normalization, price/percent/market-cap formatting, the
watchlist model and the price-history chart math — the core data layer of the
Stocks tab on [subnsub.com](https://subnsub.com), published so what the tab
does with market data is auditable: the browser talks only to the site's own
origin, and every number shown is derived exactly as coded here.

## Files

- [`stock-quotes.js`](stock-quotes.js) — the module: payload readers,
  formatters, watchlist model, chart slicing/geometry/hover math
- [`demo.html`](demo.html) — minimal standalone page exercising the module
  against bundled sample payloads (runs fully offline)

## Usage

```js
import {
  readQuotePayload, fmtPrice, fmtChange, fmtMktCap,
  readHistoryPayload, sliceSeries, chartGeometry, nearestIndex,
  sanitizeWatchlist, toggleWatch,
} from './stock-quotes.js';

// The page — not the module — fetches the documents:
const quote = readQuotePayload(await (await fetch('/api/stocks?q=AAPL')).json());
if (quote){
  fmtPrice(quote.price, 'en');                        // "123.45"
  const chg = fmtChange(quote.change, quote.changePct, 'en');
  // chg → { up: true, text: "+1.23 (+1.01%)" } | null
  fmtMktCap(quote.marketCap, quote.currency, 'en');   // input is in MILLIONS
  if (quote.delayed) { /* say so — price is the last close, not live */ }
}

const points = readHistoryPayload(await (await fetch('/api/stock-history?symbol=AAPL')).json());
if (points){
  const pts = sliceSeries(points, '6M');              // re-slice locally per range
  const g = chartGeometry(pts);                       // { xs, line, area, up } for a 600×150 viewBox
  // <path d={g.area}/> + <path d={g.line}/>; hover → nearestIndex(g.xs, viewBoxX)
}
```

## `/api/stocks` payload contract

`GET /api/stocks?q=<ticker or company name>` (same-origin; `q` ≤ 40 chars —
a company name is resolved to a symbol server-side). All market-data
providers (Finnhub first, then Financial Modeling Prep, then a delayed
end-of-day fallback via Massive/Polygon) are called server-side only.

```
200 → {
  ok: true,
  symbol:    "AAPL",
  name:      "Apple Inc",          // may be absent/empty → fall back to symbol
  exchange:  "NASDAQ" | null,
  currency:  "USD",                // may be absent → USD
  marketCap: 3200000 | null,       // MILLIONS of the quote currency
  weburl:    "https://…" | null,
  price:     123.45,
  change:    1.23 | null,          // vs. previous close
  changePct: 1.01 | null,
  high: …, low: …, open: …, prevClose: …,   // each number | null
  ts:        1767225600 | null,    // unix seconds of the quote
  delayed:   true                  // only on end-of-day fallback data (price = last close)
}
err → { ok: false, error }, error ∈
      invalid_query | not_found | not_configured | rate_limited | lookup_failed
```

## `/api/stock-history` payload contract

`GET /api/stock-history?symbol=<SYM>` returns the full daily close series in
one document (so switching chart ranges is a local re-slice, not a refetch):

```
200 → { ok: true, symbol: "AAPL", points: [[unixSeconds, close], …] }  // ascending by time
err → { ok: false, error }   // same error codes as /api/stocks
```

`readQuotePayload()` / `readHistoryPayload()` consume the decoded JSON; the
module itself never fetches.

## Model & notes

- **Nulls are legitimate**: providers differ in coverage, so any numeric
  field may be `null`; the formatters render those as an em-dash (empty for
  the market cap) instead of throwing or faking zeros.
- **Change line**: the sign is applied to both the absolute change and the
  percent (`+1.23 (+1.01%)`), using a true minus (U+2212); `up` (change ≥ 0)
  is returned separately for coloring.
- **Watchlist**: at most 12 tickers matching `/^[A-Z][A-Z0-9.\-]{0,9}$/`,
  uppercased and deduped; serialized as a plain JSON string array. The same
  validation runs on load and on toggle, so a synced or hand-edited list
  can't smuggle junk in.
- **Chart math**: range windows are `1M/30d · 3M/91d · 6M/182d · 1Y/365d ·
  5Y/1830d`; a window with fewer than 2 points degrades to the last two
  available. Geometry pads the y-range by 8%, gives flat series a synthetic
  ±2% span so they still draw, and reports `up` = last close ≥ first close.
  `chartGeometry()` emits SVG path strings for a 600×150 viewBox by default;
  `nearestIndex()` is the crosshair's binary search.
- Site-only layers are not part of this module: fetching (with its abort
  timeouts), the per-session history cache, loading skeletons and the
  result/watchlist DOM, storage/sync, and i18n.
