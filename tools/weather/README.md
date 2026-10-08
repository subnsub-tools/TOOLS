# Weather

CJK-aware geocoding decisions, condition-code → icon mapping and forecast
shaping — the data plane of the
[Weather tab on subnsub.com](https://subnsub.com), published so the part
that makes 东京 / 横浜 / 서울 searches actually work is auditable.

## Files

- [`weather-core.js`](weather-core.js) — the module: geocoding language
  pick + variant rounds + pool ranking + Nominatim-rescue decision, the
  icon/condition mappers, the Open-Meteo normaliser, the display shaping
  (°C/°F, the wind reading in km/h · m/s · Beaufort · mph with a 16-point
  compass, visibility, the city's own clock, next-48-hours strip, 3-day
  range bars) and the favourites' place identity
- [`demo.html`](demo.html) — minimal standalone page exercising the module
  on built-in sample payloads

## Usage

```js
import {
  geoLang, hasCJK, hanVariants, jaFallbackVariants,
  mergeGeoPools, rankGeoPool, needsNominatimRescue,
  parseNominatim, mergeNominatimLead, cjkQueryPlan,
  normalizeOpenMeteo, wmoIcon, wmoCondition,
  tempStr, dayName, cityClock, upcomingHours, dailyBars,
  windUnit, windSpeedStr, windDirStr, visStr,
  favEntry, favMatch, dedupeFavs,
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
const clock = cityClock(body);                        // { date, hour } on the CITY's clock
const strip = upcomingHours(body.forecast, clock);    // next 48 h, isNow / newDay flagged
const bars = dailyBars(body.forecast, useFahrenheit); // shared-range lo→hi bars

// The wind: its own unit (the reader's pick, else the °C/°F switch's),
// direction from the bearing in the reader's language.
const unit = windUnit(storedPick, useFahrenheit);     // 'kmh' | 'ms' | 'bft' | 'mph'
windSpeedStr(body.current.wind_kph, body.current.wind_mph, unit, { force: n => n + '级' });
body.current.wind_kph >= 1 ? windDirStr(body.current, localizedCompass16) : ''; // calm shows no direction
visStr(body.current.vis_km, useFahrenheit);           // '0.4 km' | '10 mi' | ''

// 4. Favourites: identity is the coordinate pair, not the display name.
const favs = [...stored, favEntry(body.location)];    // stamps lat/lon (4 dp)
favMatch(favs, body.location) >= 0;                   // starred? (東京 with Tokyo saved → yes)
const { favs: healed, dropped } = dedupeFavs(favs, f => cache[f.name]?.location);
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

## Display rules

- **The city's clock, not the viewer's.** Every hour row is stamped on the
  city's wall clock, so `cityClock()` reads "now" there: the payload's
  `location.timezone` first (it knows the city's DST), the fixed
  `utc_offset_seconds` second, the viewer's local date last. The old
  `toISOString()` UTC date lost Beijing's Now tile from midnight to 08:00
  and drew New York's 15:00 as Now at 03:30 there. `hourStripKey()` is the
  identity the page redraws the strip on when the city's hour moves.
- **The hourly strip** runs 48 hours (`opts.span`), drops everything before
  the city's current hour — a whole earlier date included, which a forecast
  cached across the city's midnight still leads with — and flags the first
  hour of each new day `newDay` so 23:00 doesn't run into 00:00 unmarked.
  `opts.selectedDate` shows one forecast day's own hours instead, elapsed
  ones included.
- **Wind** has a unit of its own (`WIND_UNITS`: km/h, m/s, Beaufort force,
  mph) because much of the world says m/s and China/Japan a force (3级);
  `''` follows the °C/°F switch. Beaufort is the lower bound of each force
  from 1 to 12 (`BFT_KMH`). The direction is drawn from `wind_deg` as one of
  16 points (the label a provider prints is English from one source and Chinese
  from another, so the bearing is the one thing every source agrees on);
  `wind_dir` is the fallback. The page shows no direction under 1 km/h —
  calm is still reported as a bearing.
- **Visibility** follows the temperature switch (km / mi); under 1 keeps a
  decimal, since 0.4 and 0 are very different fogs.
- **Favourites**: a saved city's name is the language it was *searched* in
  (the geocoder index is picked by the query's script), so 東京 and Tokyo
  once stood as two favourites. The one stable thing every response carries
  is the coordinate pair: two places within 0.05° are the same city, and
  when both sides have coords they alone decide — Springfield IL and MO
  share a name and must not merge. Name equality is the identity of last
  resort for legacy entries without coords; `dedupeFavs()` folds duplicates
  (the most recent star wins) and stamps coords onto survivors.

## Site API contract

On subnsub.com the tab only talks to the same-origin `/api/weather` proxy;
provider keys stay server-side. Requests:

- `?q=<city>&lang=<ui>` or `?lat=<lat>&lon=<lon>` → weather lookup; the
  canonical payload's `location` carries `timezone` / `utc_offset_seconds`
  and `current` a `wind_deg` bearing beside the `wind_dir` label (the
  module's own `normalizeOpenMeteo` emits all three)
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
- The hourly strip flags "now" against the clock the caller hands it —
  `cityClock()` for the city's own, a `Date` for the viewer's; icon names
  are a vocabulary, not artwork — the site maps them to its own SVG set.
- Labels are injectable, never bundled beyond English: the Beaufort word
  (`opts.force`), the 16 compass names, the day names.
