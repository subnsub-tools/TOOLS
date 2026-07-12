/* Weather — core logic of the Weather tab on subnsub.com, kept in
   lockstep with the in-page version and the same-origin /api/weather
   proxy it renders from.

   The whole tab consumes ONE canonical payload, whichever upstream
   produced it (see the README for the proxy contract):

     { ok, location: { name, country, lat, lon },
       current:  { temp_c, temp_f, feelslike_c, feelslike_f, humidity,
                   wind_kph, wind_mph, wind_dir, condition, icon,
                   is_day, uv, pressure_mb, vis_km },
       forecast: [ { date, maxtemp_c/f, mintemp_c/f, condition, icon,
                     rain_chance, hours: [ { time, temp_c/f, icon,
                     rain_chance } ] } ] }        (3 days)

   `icon` is a small shared vocabulary (sun, moon, cloud-sun, cloud-moon,
   cloud, overcast, cloud-rain-sun, cloud-rain-moon, mist, haze, wind,
   rain, heavy-rain, drizzle, snow, heavy-snow, thunder, fog, sleet) that
   each provider's native condition codes are mapped onto here.

   This module owns three things, all fetch-free (functions eat already-
   fetched payloads or plan requests as data):

   1. The CJK geocoding strategy. Open-Meteo's geocoder matches a query
      against the place names of ONE language only, so the language is
      chosen from the script of the query itself (Han → zh, kana → ja,
      hangul → ko, else the UI language). Han queries fan out over
      simplified↔traditional variants — GeoNames stores exactly one zh
      name per place (Tokyo is only 東京, mainland cities are usually
      simplified), so 东京 finds nothing without the 東京 retry. A kanji
      query that missed zh entirely gets a ja retry (raw string first:
      shinjitai forms like 横浜 must not be converted). When the ranked
      pool is still missing or village-grade for a CJK query, an OSM
      Nominatim lookup leads the result set. The simplified↔traditional
      converters are injected (see README), not bundled.
   2. The provider condition-code → icon/condition-text mappings and the
      Open-Meteo → canonical-payload normaliser, including the metric →
      imperial conversions.
   3. The display shaping of the canonical payload: °C/°F selection, the
      next-24-hours strip and the 3-day min/max range bars. */

/* ── query script detection / geocoding language pick ──────────────── */

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANA_RE = /[\u3040-\u30ff]/;
const HANGUL_RE = /[\u1100-\u11ff\uac00-\ud7af]/;
export const hasCJK = (s) => HAN_RE.test(s) || KANA_RE.test(s) || HANGUL_RE.test(s);

/* Geocoder languages are lowercase two-letter codes only — anything else
   silently matches nothing upstream, hence the strict normalisation. */
export const normLang = (raw) => {
  const l = String(raw || '').toLowerCase().split('-')[0];
  return /^[a-z]{2}$/.test(l) ? l : 'en';
};
export const geoLang = (query, uiLang) => {
  if (KANA_RE.test(query)) return 'ja';
  if (HANGUL_RE.test(query)) return 'ko';
  if (HAN_RE.test(query)) return 'zh';
  return normLang(uiLang);
};

/* A "coordinates query" is the lat,lon string form the tab produces from
   the geolocation button; it skips geocoding entirely. */
export const isCoordQuery = (q) => /^-?\d/.test(q) && q.includes(',');

/* ── geocoding variant rounds ────────────────────────────────────────
   convert = { s2t, t2s } — simplified→traditional and traditional→
   simplified single-string converters. The site generates its tables
   from the OpenCC dictionaries; missing converters degrade to identity
   (no variant fan-out). */

const cvFn = (convert, k) =>
  (convert && typeof convert[k] === 'function') ? convert[k] : (s => s);

/* Primary round: the query itself, plus (for Han queries under zh) its
   other-script forms. One geocoder call per variant, same language. */
export function hanVariants(query, lang, convert){
  const variants = [query];
  if (lang === 'zh' && HAN_RE.test(query)) {
    const s2t = cvFn(convert, 's2t'), t2s = cvFn(convert, 't2s');
    for (const v of [s2t(query), t2s(query)]) {
      if (v !== query && !variants.includes(v)) variants.push(v);
    }
  }
  return variants;
}

/* ja rescue round — fired only when a zh Han query merged to nothing.
   Official Japanese place names (東京都, 大阪市, 横浜市) only exist in
   the ja index. Raw query first — shinjitai forms like 横浜 must not be
   s2t'd (that corrupts them to 橫濱) — plus the traditional variant so
   simplified input (东京都) still lands on 東京都. */
export function jaFallbackVariants(query, convert){
  const variants = [query];
  const jt = cvFn(convert, 's2t')(query);
  if (jt !== query) variants.push(jt);
  return variants;
}

/* ── geocoder pool processing ────────────────────────────────────────
   payloads = one parsed Open-Meteo geocoding response body per variant
   call, null/undefined for calls that failed. ok:false means every call
   failed (network), as opposed to "reached and found nothing". */
export function mergeGeoPools(payloads){
  let anyOk = false;
  const seen = new Set();
  const merged = [];
  for (const data of payloads || []) {
    if (!data) continue;
    anyOk = true;
    for (const r of data.results || []) {
      if (!r || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') continue;
      const id = r.id != null ? r.id : `${r.latitude},${r.longitude}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(r);
    }
  }
  return { ok: anyOk, results: merged };
}

/* Rank the merged pool by population so the metropolis beats the
   same-named villages (searching 东京 under language=zh literally
   returns two hamlets in Jiangsu/Zhejiang before the s2t retry finds
   東京), breaking ties by feature class: national capital, then
   first-order admin seat. Sorts in place and returns the array. */
export const FEATURE_RANK = { PPLC: 2, PPLA: 1 };
export function rankGeoPool(results){
  return results.sort((a, b) =>
    ((b.population || 0) - (a.population || 0)) ||
    ((FEATURE_RANK[b.feature_code] || 0) - (FEATURE_RANK[a.feature_code] || 0)));
}

/* Open-Meteo's zh index misses even NYC / Rome / Seoul (纽约 matches
   only a Kentucky hamlet, 首尔 nothing at all), and a wrong-city hit is
   worse than a miss. OSM's localized tags are complete, so when a CJK
   query's best hit is absent or a sub-100k place, Nominatim leads.
   Call on the RANKED pool — results[0] must be the best hit. */
export function needsNominatimRescue(query, ranked){
  return hasCJK(query) && (!ranked.length || (ranked[0].population || 0) < 100000);
}

/* Normalise a Nominatim jsonv2 response into the geocoder result shape.
   Only place/boundary rows count; OSM localized tags often pack variants
   into one value — "纽约;紐約", "韩国 / 南韓" — keep the first. */
export function parseNominatim(data, query){
  if (!Array.isArray(data)) return [];
  const first = (s) => (typeof s === 'string' ? s.split(/[;；]|\s\/\s/)[0].trim() : s) || null;
  const out = [];
  for (const it of data) {
    if (!it || (it.category !== 'place' && it.category !== 'boundary')) continue;
    const la = parseFloat(it.lat), lo = parseFloat(it.lon);
    if (!isFinite(la) || !isFinite(lo)) continue;
    const parts = String(it.display_name || '').split(', ');
    out.push({
      id: `nom:${it.place_id}`,
      name: first(it.name || parts[0]) || query,
      latitude: la, longitude: lo,
      country: parts.length > 1 ? first(parts[parts.length - 1]) : null,
      admin1: parts.length > 2 ? first(parts[parts.length - 2]) : null,
    });
  }
  return out;
}

/* Rescue merge: Nominatim results lead, the ranked pool follows minus
   anything within ~0.05° of a Nominatim hit (same place, two sources).
   An empty rescue keeps the pool untouched. */
export function mergeNominatimLead(nom, ranked){
  if (!nom.length) return ranked;
  const near = (a, b) => Math.abs(a.latitude - b.latitude) < 0.05 && Math.abs(a.longitude - b.longitude) < 0.05;
  return [...nom, ...ranked.filter(m => !nom.some(n => near(n, m)))];
}

/* Autocomplete result shaping (the ?geo= endpoint's response rows). */
export function geoSuggestions(results){
  return results.slice(0, 6).map(r => ({
    name: clip(r.name, 60), country: clip(r.country, 40), admin1: clip(r.admin1, 40),
    lat: r.latitude, lon: r.longitude,
  }));
}

/* Weather lookups resolve CJK city names to coordinates up-front (the
   keyed providers barely understand them — Beijing in Chinese 404s on
   all three), keeping the geocoder's localized name for the response.
   geo = the { ok, results } outcome of the geocoding rounds above.
     → { action:'coords', query:'lat,lon', override:{name,country} }
     → { action:'not_found' }  geocoder reached and found nothing; the
        other providers would just repeat this miss, so short-circuit
     → { action:'raw' }        geocoder network failure; let the
        provider chain try the raw query */
export function cjkQueryPlan(query, geo){
  if (geo.results.length) {
    const top = geo.results[0];
    return {
      action: 'coords',
      query: `${top.latitude},${top.longitude}`,
      override: { name: clip(top.name, 60), country: clip(top.country, 40) },
    };
  }
  if (geo.ok) return { action: 'not_found' };
  return { action: 'raw' };
}

/* ── condition-code → icon mappings ──────────────────────────────────
   One mapper per provider the site's proxy can consume, all onto the
   same icon vocabulary. */

/* WeatherAPI condition codes (keyed tier-1 provider, when configured). */
export function waIcon(code, isDay){
  if (code === 1000) return isDay ? 'sun' : 'moon';
  if (code === 1003) return isDay ? 'cloud-sun' : 'cloud-moon';
  if (code === 1006) return 'cloud';
  if (code === 1009) return 'overcast';
  if (code === 1030) return 'mist';
  if (code === 1135 || code === 1147) return 'fog';
  if ([1063,1150,1153,1180,1183].includes(code)) return isDay ? 'cloud-rain-sun' : 'cloud-rain-moon';
  if ([1186,1189,1240,1243].includes(code)) return 'rain';
  if ([1192,1195,1198,1201,1246].includes(code)) return 'heavy-rain';
  if ([1066,1210,1213,1255].includes(code)) return 'snow';
  if ([1114,1117,1216,1219,1222,1225,1258].includes(code)) return 'heavy-snow';
  if ([1069,1072,1168,1171,1204,1207,1237,1249,1252,1261,1264].includes(code)) return 'sleet';
  if ([1087,1273,1276,1279,1282].includes(code)) return 'thunder';
  return 'cloud';
}

/* OpenWeatherMap condition ids (keyed tier-2 provider, when configured). */
export function owmIcon(id, isDay){
  if (id >= 200 && id < 300) return 'thunder';
  if (id >= 300 && id < 400) return 'drizzle';
  if (id === 500 || id === 501) return 'rain';
  if (id >= 502 && id < 600) return 'heavy-rain';
  if (id >= 600 && id <= 601) return 'snow';
  if (id >= 602 && id < 700) return 'heavy-snow';
  if (id === 701 || id === 721) return 'mist';
  if (id === 741) return 'fog';
  if (id === 771 || id === 781) return 'wind';
  if (id >= 700 && id < 800) return 'haze';
  if (id === 800) return isDay ? 'sun' : 'moon';
  if (id === 801) return isDay ? 'cloud-sun' : 'cloud-moon';
  if (id === 802) return 'cloud';
  return 'overcast';
}

/* WMO weather codes (Open-Meteo, the keyless always-available tier). */
export function wmoIcon(code, isDay){
  if (code === 0) return isDay ? 'sun' : 'moon';
  if (code === 1) return isDay ? 'cloud-sun' : 'cloud-moon';
  if (code === 2) return 'cloud';
  if (code === 3) return 'overcast';
  if (code === 45) return 'mist';
  if (code === 48) return 'fog';
  if (code >= 51 && code <= 55) return 'drizzle';
  if (code === 56 || code === 57) return 'sleet';
  if (code === 61 || code === 63 || code === 80 || code === 81) return 'rain';
  if (code === 65 || code === 82) return 'heavy-rain';
  if (code === 66 || code === 67) return 'sleet';
  if (code === 71 || code === 73 || code === 77 || code === 85) return 'snow';
  if (code === 75 || code === 86) return 'heavy-snow';
  if (code >= 95) return 'thunder';
  return 'cloud';
}

/* WMO code → condition text (Open-Meteo reports no text of its own). */
export function wmoCondition(code){
  const map = {
    0:'Clear',1:'Mainly Clear',2:'Partly Cloudy',3:'Overcast',
    45:'Fog',48:'Rime Fog',51:'Light Drizzle',53:'Drizzle',55:'Dense Drizzle',
    56:'Freezing Drizzle',57:'Heavy Freezing Drizzle',
    61:'Light Rain',63:'Rain',65:'Heavy Rain',66:'Freezing Rain',67:'Heavy Freezing Rain',
    71:'Light Snow',73:'Snow',75:'Heavy Snow',77:'Snow Grains',
    80:'Rain Showers',81:'Moderate Showers',82:'Violent Showers',
    85:'Snow Showers',86:'Heavy Snow Showers',
    95:'Thunderstorm',96:'Thunderstorm with Hail',99:'Severe Thunderstorm',
  };
  return map[code] || 'Unknown';
}

/* 8-point compass direction from degrees. */
export const windDir = (deg) => {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8] || '';
};

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

/* ── Open-Meteo → canonical payload ──────────────────────────────────
   data = a parsed open-meteo.com /v1/forecast response (current +
   hourly + daily blocks, 3 forecast days); geoName/geoCountry = the
   geocoder's localized name for the place (Open-Meteo itself only knows
   coordinates). Metric→imperial conversions happen here so consumers
   never convert. */
export function normalizeOpenMeteo(data, geoName, geoCountry){
  const cur = data.current || {};
  const hourly = data.hourly || {};
  const daily = data.daily || {};
  const isDay = !!cur.is_day;

  const hTimes = hourly.time || [];
  const hTemps = hourly.temperature_2m || [];
  const hCodes = hourly.weather_code || [];
  const hRain = hourly.precipitation_probability || [];
  const hIsDay = hourly.is_day || [];

  const dDates = daily.time || [];
  const dMax = daily.temperature_2m_max || [];
  const dMin = daily.temperature_2m_min || [];
  const dCodes = daily.weather_code || [];
  const dRain = daily.precipitation_probability_max || [];

  const forecast = dDates.slice(0, 3).map((date, di) => {
    const dayHours = [];
    for (let hi = 0; hi < hTimes.length; hi++) {
      if ((hTimes[hi] || '').startsWith(date)) {
        dayHours.push({
          time: (hTimes[hi] || '').slice(11, 16),
          temp_c: hTemps[hi] ?? null,
          temp_f: hTemps[hi] != null ? Math.round((hTemps[hi] * 9 / 5 + 32) * 10) / 10 : null,
          icon: wmoIcon(hCodes[hi] || 0, hIsDay[hi] !== undefined ? !!hIsDay[hi] : true),
          rain_chance: hRain[hi] || 0,
        });
      }
    }
    return {
      date,
      maxtemp_c: dMax[di] ?? null, maxtemp_f: dMax[di] != null ? Math.round((dMax[di] * 9 / 5 + 32) * 10) / 10 : null,
      mintemp_c: dMin[di] ?? null, mintemp_f: dMin[di] != null ? Math.round((dMin[di] * 9 / 5 + 32) * 10) / 10 : null,
      condition: wmoCondition(dCodes[di]),
      icon: wmoIcon(dCodes[di] || 0, true),
      rain_chance: dRain[di] || 0,
      hours: dayHours,
    };
  });

  return {
    ok: true,
    location: {
      name: clip(geoName || data.timezone, 60),
      country: clip(geoCountry, 40),
      lat: data.latitude, lon: data.longitude,
    },
    current: {
      temp_c: cur.temperature_2m ?? null,
      temp_f: cur.temperature_2m != null ? Math.round((cur.temperature_2m * 9 / 5 + 32) * 10) / 10 : null,
      feelslike_c: cur.apparent_temperature ?? null,
      feelslike_f: cur.apparent_temperature != null ? Math.round((cur.apparent_temperature * 9 / 5 + 32) * 10) / 10 : null,
      humidity: cur.relative_humidity_2m ?? null,
      wind_kph: cur.wind_speed_10m ?? null,
      wind_mph: cur.wind_speed_10m != null ? Math.round(cur.wind_speed_10m * 0.6214 * 10) / 10 : null,
      wind_dir: windDir(cur.wind_direction_10m || 0),
      condition: wmoCondition(cur.weather_code),
      icon: wmoIcon(cur.weather_code || 0, isDay),
      is_day: isDay, uv: cur.uv_index || null,
      pressure_mb: cur.surface_pressure ? Math.round(cur.surface_pressure) : null,
      vis_km: null,
    },
    forecast,
  };
}

/* ── display shaping ─────────────────────────────────────────────────
   The canonical payload always carries both units; display picks one. */

export function tempStr(c, f, fahrenheit){
  const v = fahrenheit ? f : c;
  return v != null ? Math.round(v) + (fahrenheit ? '°F' : '°C') : '—';
}
export function tempNum(c, f, fahrenheit){
  const v = fahrenheit ? f : c;
  return v != null ? Math.round(v) + '°' : '—';
}

/* Forecast-day label: Today / Tomorrow / short weekday. Comparison runs
   at local noon so DST shifts can't move a date across the midnight line.
   opts: { locale, today, tomorrow, now } — label strings are i18n'd
   on-site and injectable here. */
export function dayName(dateStr, opts){
  opts = opts || {};
  try {
    const d = new Date(dateStr + 'T12:00:00');
    const today = opts.now ? new Date(opts.now) : new Date();
    today.setHours(12, 0, 0, 0);
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return opts.today || 'Today';
    if (diff === 1) return opts.tomorrow || 'Tomorrow';
    return d.toLocaleDateString(opts.locale, { weekday: 'short' });
  } catch (_) { return dateStr; }
}

/* The hourly strip: up to the next 24 forecast hours across day
   boundaries — today's already-past hours are skipped and the current
   hour is flagged isNow. */
export function upcomingHours(forecast, now){
  if (!forecast || !forecast.length) return [];
  now = now ? new Date(now) : new Date();
  const curHr = now.getHours();
  const todayStr = now.toISOString().slice(0, 10);
  const hours = [];
  for (let di = 0; di < forecast.length && hours.length < 24; di++) {
    const day = forecast[di];
    for (let hi = 0; hi < (day.hours || []).length && hours.length < 24; hi++) {
      const h = day.hours[hi];
      const hNum = parseInt(h.time.slice(0, 2), 10);
      if (day.date === todayStr && hNum < curHr) continue;
      hours.push({
        time: h.time, temp_c: h.temp_c, temp_f: h.temp_f, icon: h.icon,
        rain: h.rain_chance, isNow: day.date === todayStr && hNum === curHr,
      });
    }
  }
  return hours;
}

/* The daily rows: each day's low→high segment positioned inside the
   3-day overall range (left/width in %, one decimal), so the bars line
   up as a shared thermometer. */
export function dailyBars(forecast, fahrenheit){
  if (!forecast) return [];
  let allMin = Infinity, allMax = -Infinity;
  for (let i = 0; i < forecast.length; i++) {
    const f = forecast[i];
    const lo = fahrenheit ? f.mintemp_f : f.mintemp_c;
    const hi = fahrenheit ? f.maxtemp_f : f.maxtemp_c;
    if (lo < allMin) allMin = lo;
    if (hi > allMax) allMax = hi;
  }
  const range = allMax - allMin || 1;
  return forecast.map(d => {
    const dlo = fahrenheit ? d.mintemp_f : d.mintemp_c;
    const dhi = fahrenheit ? d.maxtemp_f : d.maxtemp_c;
    return {
      date: d.date, icon: d.icon, rain_chance: d.rain_chance,
      lo: dlo, hi: dhi,
      left: ((dlo - allMin) / range * 100).toFixed(1),
      width: (((dhi - dlo) / range) * 100).toFixed(1),
    };
  });
}
