# Weather Core

CJK-aware geocoding decisions, condition-code → icon mapping and forecast
shaping — the data-plane core of the
[Weather tab on subnsub.com](https://subnsub.com), published so the part
that makes 东京 / 横浜 / 서울 searches actually work is auditable.

## Files

- [`weather-core.js`](weather-core.js) — the module: geocoding language
  pick + variant rounds + pool ranking + Nominatim-rescue decision, the
  icon/condition mappers, the Open-Meteo normaliser, and the display
  shaping (°C/°F, next-24-hours strip, 3-day range bars)
- [`demo.html`](demo.html) — minimal standalone page exercising the module
  on built-in sample payloads

## Usage

```js
import {
  geoLang, hasCJK, hanVariants, jaFallbackVariants,
  mergeGeoPools, rankGeoPool, needsNominatimRescue,
  parseNominatim, mergeNominatimLead, cjkQueryPlan,
  normalizeOpenMeteo, wmoIcon, wmoCondition,
  tempStr, dayName, upcomingHours, dailyBars,
} from './weather-core.js';

// 1. Plan the geocoder calls (the module plans; the caller fetches).
const lang = geoLang('东京', uiLang);                 // script → 'zh'
const round1 = hanVariants('东京', lang, { s2t, t2s }); // ['东京', '東京']
let payloads = await Promise.all(round1.map(v => fetchGeo(v, lang)));
let pool = mergeGeoPools(payloads);
if (!pool.results.length && lang === 'zh') {          // ja rescue round
  const round2 = jaFallbackVariants('东京', { s2t }); // raw string first
  payloads = payloads.concat(await Promise.all(round2.map(v => fetchGeo(v, 'ja'))));
  pool = mergeGeoPools(payloads);
}
rankGeoPool(pool.results);
if (needsNominatimRescue('东京', pool.results)) {     // missing or village-grade
  const nom = parseNominatim(await fetchNominatim('东京', lang), '东京');
  pool.results = mergeNominatimLead(nom, pool.results);
}
const plan = cjkQueryPlan('东京', pool);              // coords | not_found | raw

// 2. Normalise a fetched Open-Meteo forecast into the canonical payload.
const body = normalizeOpenMeteo(omForecastPayload, plan.override?.name, plan.override?.country);

// 3. Shape it for display.
tempStr(body.current.temp_c, body.current.temp_f, useFahrenheit); // '28°C'
const strip = upcomingHours(body.forecast);           // next 24 h, isNow flagged
const bars = dailyBars(body.forecast, useFahrenheit); // shared-range lo→hi bars
```

The simplified↔traditional converters are **injected**, not bundled:
`hanVariants` / `jaFallbackVariants` take `{ s2t, t2s }` string-mapping
functions and degrade to no fan-out without them. The site's converters are
single-character tables generated from the
[OpenCC](https://github.com/BYVoid/OpenCC) dictionaries (Apache-2.0).

## Why the geocoding is shaped like this

- Open-Meteo's geocoder matches a query against the place names of **one
  language only**, so the language is chosen from the query's script
  (Han → zh, kana → ja, hangul → ko, else the UI language).
- GeoNames stores exactly one zh name per place (Tokyo is only 東京,
  mainland cities are usually simplified), so Han queries fan out over
  both scripts and the pools are merged and ranked by population —
  searching 东京 under `language=zh` literally returns two hamlets before
  the 東京 retry finds Tokyo.
- Official Japanese place names (東京都, 横浜市) only exist in the ja
  index; the ja retry keeps the raw string first because shinjitai forms
  like 横浜 must not be converted (that corrupts them to 橫濱).
- The zh index misses even NYC / Rome / Seoul, and a wrong-city hit is
  worse than a miss — when a CJK query's best hit is absent or sub-100k,
  an OSM Nominatim lookup leads the result set.
- CJK city names are resolved to coordinates **before** any weather
  provider is asked (they barely understand CJK), keeping the geocoder's
  localized place name for the response.

## Site API contract

On subnsub.com the tab only talks to the same-origin `/api/weather` proxy;
provider keys stay server-side. Requests:

- `?q=<city>&lang=<ui>` or `?lat=<lat>&lon=<lon>` → weather lookup
- `?geo=<query>&lang=<ui>` → autocomplete,
  `{ ok, results: [{ name, country, admin1, lat, lon }] }`
- failures → `{ ok: false, error }` with `error` ∈ `missing_query |
  invalid_query | not_found | not_configured | rate_limited | lookup_failed`

The proxy tries providers in order until one answers: keyed tiers
(WeatherAPI, then OpenWeatherMap — hence `waIcon` / `owmIcon`) when
configured, and the key-free Open-Meteo tier otherwise, whose geocoder
also powers the CJK strategy above and the autocomplete. Every provider is
normalised to the canonical payload documented at the top of the module,
with both °C/°F precomputed so clients never convert.

## Boundaries

- Zero network, storage or DOM in the module — it plans requests and eats
  parsed payloads. Rate limiting, caching and key handling are the site
  proxy's business.
- The hourly strip flags "now" against the caller's clock; icon names are
  a vocabulary, not artwork — the site maps them to its own SVG set.
