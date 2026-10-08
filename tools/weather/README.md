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
  compass, visibility, the city's own clock, next-48-hours strip and which
  readings it can switch to, 3-day range bars, today against yesterday, the
  day's length, the air's make-up) and the favourites' place identity
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
  hourMetrics, windToward, uvBand,
  yesterdayRow, vsYesterday, daylight, pollutants,
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
hourMetrics(strip);                                   // ['temp','feels','rain','wind','uv','air'] the hours carry
windToward(strip[0].src.wind_deg);                    // the arrow's bearing: where it blows TO
uvBand(strip[0].src.uv);                              // 1 low … 5 extreme (WHO)

// Today against yesterday, the day's length and the air read a fuller
// payload than the Open-Meteo normaliser fills: day rows with sunrise and
// sunset as 'HH:MM', a `history` list of past days and an `air` block in
// µg/m³ (the site's own weather endpoint returns that shape).
const full = {
  forecast: [{ date: '2026-10-09', maxtemp_c: 16, maxtemp_f: 60.8, sunrise: '07:31', sunset: '18:39' },
             { date: '2026-10-10', maxtemp_c: 15, maxtemp_f: 59, sunrise: '07:33', sunset: '18:37' }],
  history:  [{ date: '2026-10-08', maxtemp_c: 14, maxtemp_f: 57.2, sunrise: '07:29', sunset: '18:42' }],
  air: { index: 1, pm2_5: 8.4, pm10: 12.9, o3: 61.2, no2: 12.3 },
};
const y = yesterdayRow(full.history, full.forecast);
y && vsYesterday(full.forecast[0], y, useFahrenheit); // 2 → "2° warmer than yesterday"
daylight(full.forecast[0], y, full.forecast[1]);      // { minutes: 668, delta: -5, against: 'yesterday' }
pollutants(full.air);                                 // [{ key: 'pm2_5', label: 'PM2.5', value: 8.4 }, …]

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
- **The rest of an hour.** Besides temperature and the chance of rain, each
  hour can carry what it feels like, the wind (bearing it comes from) and
  its gusts, UV, how much falls and the air's band — whatever the serving
  provider has (`hourDetail()` builds the fields; the three-hour fallback
  has no UV). The strip switches between them, and `hourMetrics()` offers a
  reading only when at least half the hours on screen carry it.
- **Today against yesterday**: whole degrees of the unit on screen; the
  page says "as warm as yesterday" within a degree. **Daylight** is sunset
  minus sunrise on the city's clock, its change in minutes against
  yesterday when the card holds yesterday, else against tomorrow.
- **The air**: the band is the US EPA's six (`air.index`), from whichever
  provider answered; `pollutants()` lists PM2.5, PM10, O₃, NO₂, SO₂ and CO in
  µg/m³ only when there is more than the particulates the band line names.
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
  module's own `normalizeOpenMeteo` emits all three); hours carry the
  extra readings above where the provider has them, `air` its pollutants,
  and each alert the authority's own `desc` and `instruction` when it sent
  them
- `?fc=<lat>,<lon>&days=<n>` → a deeper forecast (Open-Meteo alone, up to
  14 days), `{ ok, forecast }`
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
