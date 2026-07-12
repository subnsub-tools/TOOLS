# Today Aggregate

The pin model, refresh discipline and signature-gated rendering behind the
[Today tab on subnsub.com](https://subnsub.com) — the dashboard that
aggregates favourites from the other tabs (weather cities, currency pairs,
the stock watchlist, today's World Cup matches, day counters) into one
board. Published so the scheduling and render-stability rules are
auditable.

## Files

- [`today-aggregate.js`](today-aggregate.js) — the module: pin model,
  per-tool TTL scheduling + settle rules, payload signatures, favourite
  list validation, time-zone day math, per-tool render-data shaping
- [`demo.html`](demo.html) — minimal standalone page exercising the module
  on built-in sample payloads

## Usage

```js
import {
  parsePins, serializePins, togglePin, KNOWN_TOOLS,
  poolEntry, due, dueFetches, settleWeather, weatherSig, TTL,
  wxFavCities, fxFavList, stkFavList,
} from './today-aggregate.js';

// Pin model: ordered, whitelisted, de-duplicated tool ids.
let pins = parsePins(storedString);            // junk folds to []
({ pins } = togglePin(pins, 'weather', { maxPins: 5 })); // unpin always works
store(serializePins(pins));                    // null = remove key (default state)

// Refresh discipline: fetch only what the board shows, only when due.
const pool = {};
for (const city of dueFetches('weather', { weather: cities }, { weather: pool })) {
  const st = poolEntry(pool, city.toLowerCase());
  st.loading = true;
  settleWeather(st, await fetchWeather(city)); // failure back-dates → ~30 s retry
}

// Signature criterion: rebuild a tile only when its signature changes.
const sig = weatherSig(cities, pool, { fahrenheit: false, lang: 'en' });
if (sig !== lastSig) { lastSig = sig; rebuildTile(); }
```

## The adapter contract

Each pinnable tool is one tile implementing the same interface; the DOM
renderers stay on-site, this module supplies everything below. Favourite
inputs are the source tabs' own stored lists (parsed values in, validated
and capped lists out).

| id | favourites in | fetch (site proxy) | TTL | settle rule | signature |
|---|---|---|---|---|---|
| `weather` | `wxFavCities` — city names, deduped, ≤ 10 | `/api/weather?q=…&lang=…` per city (or `?lat=&lon=` — `wxRequest` routes stored coordinate pairs) | 15 min | `settleWeather`: failure back-dates to a ~30 s retry | `weatherSig`: current + location + first forecast day, plus °F flag and language |
| `fx` | `fxFavList` — validated `{from,to,amount}` pairs, ≤ 8, legacy single pin honoured | `/api/rates` once, shared USD-based table; a cached table fresher than the TTL is adopted with **its own** timestamp (`validFxCache` / `fxCacheFresh` / `adoptFxCache`) | 60 min | `settleFx`: a failed refresh shows the stale table but keeps a ~60 s retry window | `fxSig`: table date + each pair's two rates |
| `stock` | `stkFavList` — ticker whitelist regex, ≤ 12 | `/api/stocks?q=…` per ticker | 2 min | `settleStock`: keeps the stale quote on failure (better delayed than blank) | `stockSig`: whole quote payload |
| `worldcup` | singleton | `/api/worldcup?dateFrom=&dateTo=` (`wcFetchRange`: local ±1 day) | 2 min | `settleWorldcup` | `worldcupSig`: today's matches in the board zone + day key + zone |
| `countdown` | singleton | none — pure local Timer-tab data | — | — | `countdownSig`: raw stored string + day key |

Shared rules the site's scheduler applies on top:

- **Day roll**: when `dayKey()` changes, `resetPool(weatherPool)` and zero
  the World Cup entry — their "today" answers moved.
- **Language change**: reset the weather pool too; condition text is
  language-baked into the payload but the pool is keyed by city only.
- **Zone chain**: the World Cup tile answers "today" in the board's zone,
  falling back to the World Cup tab's own zone, then browser-local; zone
  strings from sync are validated once per value (`makeZoneCheck`) and
  fold to browser-local when invalid.

## Why signatures sign the payload, not `fetchedAt`

A TTL refresh usually returns identical data. Signing the fetch timestamp
would make every refresh look like a change and churn DOM identity — which
the site's readability engine (and anyone's scroll/selection state) pays
for. So signatures serialise exactly what the tile renders, plus its
display inputs (language, °C/°F, zone, day key); loading and error states
sign as `-` and `e`.

## Boundaries

- Zero network, storage or DOM — parsed storage values, fetched payloads
  and clocks come in as arguments; state entries are plain records the
  caller owns.
- Favourite caps (10 / 8 / 12) mirror the source tabs so a crafted or
  stale stored list can't fan out unbounded fetches.
- `togglePin`'s `maxPins` is injectable: the site configures the pin cap
  and per-tile row trimming on its own side (display-level only — stored
  pins and favourites are never deleted). That gating, the tile DOM and
  the window-fill mode are on-site concerns, not extracted.
