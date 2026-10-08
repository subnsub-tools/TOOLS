/* Weather — logic of the Weather tab on subnsub.com, kept in
   lockstep with the in-page version and the same-origin /api/weather
   proxy it renders from.

   The whole tab consumes ONE canonical payload, whichever upstream
   produced it (see the README for the proxy contract):

     { ok, location: { name, country, lat, lon, timezone,
                       utc_offset_seconds },
       current:  { temp_c, temp_f, feelslike_c, feelslike_f, humidity,
                   wind_kph, wind_mph, wind_dir, wind_deg, condition, icon,
                   is_day, uv, pressure_mb, vis_km },
       forecast: [ { date, maxtemp_c/f, mintemp_c/f, condition, icon,
                     rain_chance, uv, precip_mm, gust_kph/mph, sunrise,
                     sunset, hours: [ { time, temp_c/f, icon, rain_chance,
                     feelslike_c/f?, wind_kph/mph?, wind_deg?, gust_kph/mph?,
                     uv?, precip_mm?, aqi? } ] } ],      (3 days)
       history?: [ same as a forecast day, without hours ],
       air?: { index (US EPA band 1-6), pm2_5, pm10, o3?, no2?, so2?, co? },
       alerts?: [ { event, severity, expires, desc?, instruction? } ] }

   An hour's extra readings ride where the serving provider has them and
   are simply absent where it does not — the strip offers only the readings
   the hours carry (hourMetrics).

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
      wind reading (km/h · m/s · Beaufort · mph, 16-point compass from the
      bearing), visibility, the city's own clock, the next-48-hours strip
      and the 3-day min/max range bars.
   4. The favourites model: a saved city's identity is its coordinate pair,
      not its display name, so 東京 and Tokyo fold into one favourite. */

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
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/* ── Open-Meteo → canonical payload ──────────────────────────────────
   data = a parsed open-meteo.com /v1/forecast response (current +
   hourly + daily blocks, 3 forecast days); geoName/geoCountry = the
   geocoder's localized name for the place (Open-Meteo itself only knows
   coordinates). Metric→imperial conversions happen here so consumers
   never convert. */
/* The rest of an hour, as the proxy adds it for every provider: what it
   feels like, the wind (and the bearing it comes FROM) and its gusts, UV,
   how much falls. Missing inputs leave their field out; the other unit is
   derived when only one is given. Returns the row. */
export function hourDetail(row, v){
  const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
  if (Number.isFinite(v.feels_c)) {
    row.feelslike_c = r1(v.feels_c);
    row.feelslike_f = Number.isFinite(v.feels_f) ? r1(v.feels_f) : r1(v.feels_c * 9 / 5 + 32);
  }
  if (Number.isFinite(v.wind_kph)) {
    row.wind_kph = r1(v.wind_kph);
    row.wind_mph = Number.isFinite(v.wind_mph) ? r1(v.wind_mph) : r1(v.wind_kph * 0.6214);
    if (Number.isFinite(v.wind_deg)) row.wind_deg = Math.round(v.wind_deg);
    if (Number.isFinite(v.gust_kph)) {
      row.gust_kph = r1(v.gust_kph);
      row.gust_mph = Number.isFinite(v.gust_mph) ? r1(v.gust_mph) : r1(v.gust_kph * 0.6214);
    }
  }
  if (Number.isFinite(v.uv)) row.uv = r1(v.uv);
  if (Number.isFinite(v.precip_mm)) row.precip_mm = r1(v.precip_mm);
  return row;
}

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
  const hFeels = hourly.apparent_temperature || [];
  const hWind = hourly.wind_speed_10m || [];
  const hWindDeg = hourly.wind_direction_10m || [];
  const hGust = hourly.wind_gusts_10m || [];
  const hUv = hourly.uv_index || [];
  const hPrecip = hourly.precipitation || [];

  const dDates = daily.time || [];
  const dMax = daily.temperature_2m_max || [];
  const dMin = daily.temperature_2m_min || [];
  const dCodes = daily.weather_code || [];
  const dRain = daily.precipitation_probability_max || [];

  const forecast = dDates.slice(0, 3).map((date, di) => {
    const dayHours = [];
    for (let hi = 0; hi < hTimes.length; hi++) {
      if ((hTimes[hi] || '').startsWith(date)) {
        dayHours.push(hourDetail({
          time: (hTimes[hi] || '').slice(11, 16),
          temp_c: hTemps[hi] ?? null,
          temp_f: hTemps[hi] != null ? Math.round((hTemps[hi] * 9 / 5 + 32) * 10) / 10 : null,
          icon: wmoIcon(hCodes[hi] || 0, hIsDay[hi] !== undefined ? !!hIsDay[hi] : true),
          rain_chance: hRain[hi] || 0,
        }, {
          feels_c: hFeels[hi], wind_kph: hWind[hi], wind_deg: hWindDeg[hi], gust_kph: hGust[hi],
          uv: hUv[hi], precip_mm: hPrecip[hi],
        }));
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
      /* the city's wall clock — cityClock() reads these; the zone name
         knows the city's DST, the fixed offset is the fallback */
      timezone: clip(data.timezone, 60),
      utc_offset_seconds: num(data.utc_offset_seconds),
    },
    current: {
      temp_c: cur.temperature_2m ?? null,
      temp_f: cur.temperature_2m != null ? Math.round((cur.temperature_2m * 9 / 5 + 32) * 10) / 10 : null,
      feelslike_c: cur.apparent_temperature ?? null,
      feelslike_f: cur.apparent_temperature != null ? Math.round((cur.apparent_temperature * 9 / 5 + 32) * 10) / 10 : null,
      humidity: cur.relative_humidity_2m ?? null,
      wind_kph: cur.wind_speed_10m ?? null,
      wind_mph: cur.wind_speed_10m != null ? Math.round(cur.wind_speed_10m * 0.6214 * 10) / 10 : null,
      /* wind_dir is for reading, wind_deg is for computing (windDirStr
         draws its 16-point label from the bearing) */
      wind_dir: windDir(cur.wind_direction_10m || 0), wind_deg: num(cur.wind_direction_10m),
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

/* Day label: Yesterday / Today / Tomorrow / short weekday.

   Measured against opts.baseDate — the CITY's today, i.e. the forecast's
   own first day — rather than the viewer's clock. The two disagree across
   the date line: a viewer in Shanghai looking up Honolulu (still on the
   previous day) would see the city's TODAY labelled "Yesterday" and the
   real past day pushed out to a weekday name. Both values are bare
   calendar dates, so the diff runs on the UTC day index and neither the
   viewer's zone nor a DST jump enters the arithmetic.

   Without a baseDate it falls back to opts.now / the local clock, still
   compared at local noon so DST can't move a date across midnight.
   opts: { locale, today, tomorrow, yesterday, baseDate, now } — label
   strings are i18n'd on-site and injectable here. */
export function dayName(dateStr, opts){
  opts = opts || {};
  try {
    let diff = NaN;
    if (opts.baseDate) {
      const a = Date.parse(dateStr + 'T00:00:00Z'), b = Date.parse(opts.baseDate + 'T00:00:00Z');
      if (!isNaN(a) && !isNaN(b)) diff = Math.round((a - b) / 86400000);
    }
    if (isNaN(diff)) {
      const d0 = new Date(dateStr + 'T12:00:00');
      const t0 = opts.now ? new Date(opts.now) : new Date();
      t0.setHours(12, 0, 0, 0);
      diff = Math.round((d0 - t0) / 86400000);
    }
    if (diff === 0) return opts.today || 'Today';
    if (diff === 1) return opts.tomorrow || 'Tomorrow';
    if (diff === -1) return opts.yesterday || 'Yesterday';
    return new Date(dateStr + 'T12:00:00').toLocaleDateString(opts.locale, { weekday: 'short' });
  } catch (_) { return dateStr; }
}

/* ── the city's own clock ──
   Every row the strips draw is stamped on the CITY's wall clock (the
   proxy's providers all report local time), so "now" has to be read off
   that clock too. The viewer's getHours() was right only for a city in the
   viewer's own zone, and toISOString() handed over the UTC date besides:
   from midnight to 08:00 in Beijing the strip lost its Now tile and led
   with hours already gone, and Shanghai looking at New York at 15:30 drew
   New York's 15:00 as Now while it was 03:30 there. The zone name wins (it
   knows the city's DST), the fixed offset is the fallback for a payload
   carrying only that, and the viewer's LOCAL date is the last resort.
   data = the canonical payload (its location is read); now = Date/epoch,
   default the clock. → { date: 'YYYY-MM-DD', hour: 0–23 } */
export function cityClock(data, now){
  const loc = (data && data.location) || {};
  now = now != null ? new Date(now) : new Date();
  if (loc.timezone){
    try {
      const p = {};
      new Intl.DateTimeFormat('en-US', { timeZone: loc.timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23' })
        .formatToParts(now).forEach(x => { p[x.type] = x.value; });
      const hr = parseInt(p.hour, 10);
      if (p.year && p.month && p.day && isFinite(hr)) return { date: p.year + '-' + p.month + '-' + p.day, hour: hr % 24 };
    } catch (_) {}
  }
  const off = loc.utc_offset_seconds;
  if (typeof off === 'number' && isFinite(off)){
    const t = new Date(now.getTime() + off * 1000);
    return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
  }
  const m = now.getMonth() + 1, dd = now.getDate();
  return { date: now.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd, hour: now.getHours() };
}

/* Identity of the hour the strip was drawn for: the Now tile moves when the
   city's hour does, so the page redraws the strip (no fetch) whenever this
   key changes between ticks. */
export const hourStripKey = (clock) => clock.date + 'T' + clock.hour;

/* The hourly strip: up to the next 48 forecast hours across day boundaries
   (opts.span). Everything before the city's current hour is gone — a whole
   earlier date included, which a forecast cached across the city's midnight
   still leads with — and the current hour is flagged isNow. Each row
   carries its date, and the first hour of each new day is flagged newDay so
   23:00 doesn't run straight into 00:00 with nothing to say a day turned
   (the page labels it with dayName(row.date, { baseDate })).
   With opts.selectedDate — a day picked in the daily list — the strip shows
   that day's own hours instead, elapsed ones included (the current hour
   still wears Now); a date that carries no hours falls back to the run.
   clock = cityClock()'s { date, hour }; a Date/epoch is accepted for the
   viewer's own zone (the last-resort branch above). */
export function upcomingHours(forecast, clock, opts){
  if (!forecast || !forecast.length) return [];
  opts = opts || {};
  const span = opts.span > 0 ? opts.span : 48;
  const clk = (clock && typeof clock === 'object' && typeof clock.date === 'string') ? clock : cityClock(null, clock);
  const curHr = clk.hour, todayStr = clk.date;
  /* src: the forecast's own hour, for the readings beyond temperature */
  const row = (day, h) => ({
    time: h.time, date: day.date, temp_c: h.temp_c, temp_f: h.temp_f, icon: h.icon,
    rain: h.rain_chance, src: h, isNow: day.date === todayStr && parseInt(h.time.slice(0, 2), 10) === curHr,
  });
  const hours = [];
  const sel = opts.selectedDate ? forecast.find(d => d.date === opts.selectedDate && d.hours && d.hours.length) : null;
  if (sel) {
    for (const h of sel.hours) hours.push(row(sel, h));
  } else {
    for (let di = 0; di < forecast.length && hours.length < span; di++) {
      const day = forecast[di];
      for (let hi = 0; hi < (day.hours || []).length && hours.length < span; hi++) {
        const h = day.hours[hi];
        const hNum = parseInt(h.time.slice(0, 2), 10);
        if (day.date < todayStr || (day.date === todayStr && hNum < curHr)) continue;
        hours.push(row(day, h));
      }
    }
  }
  hours.forEach((h, i) => { h.newDay = i > 0 && !h.isNow && h.date !== hours[i - 1].date; });
  return hours;
}

/* What the strip can show besides temperature: a reading counts when at
   least half the hours on screen carry it (and two at the least), so a
   reading the next hours mostly lack never draws a row of dashes.
   → ['temp', 'feels', 'rain', 'wind', 'uv', 'air'] filtered, temp always. */
export const HOUR_METRICS = [
  ['temp', (h) => h.temp_c != null], ['feels', (h) => h.feelslike_c != null],
  ['rain', (h) => h.precip_mm != null], ['wind', (h) => h.wind_kph != null],
  ['uv', (h) => h.uv != null], ['air', (h) => h.aqi != null],
];
export function hourMetrics(hours){
  return HOUR_METRICS.filter(([k, has]) => {
    if (k === 'temp') return true;
    const n = hours.filter(h => h.src && has(h.src)).length;
    return n >= Math.max(2, hours.length / 2);
  }).map(([k]) => k);
}
/* The WHO UV bands: 1 low (0-2) · 2 moderate (3-5) · 3 high (6-7) ·
   4 very high (8-10) · 5 extreme (11+) */
export const uvBand = (u) => (u < 3 ? 1 : u < 6 ? 2 : u < 8 ? 3 : u < 11 ? 4 : 5);
/* An hour's fall: a tenth of a millimetre under 10 (a day's total is
   rounded to whole millimetres from 1 up), 0 when dry; inches for °F */
export function hourPrecipStr(mm, fahrenheit){
  if (!Number.isFinite(mm)) return '';
  if (fahrenheit) { const inch = mm / 25.4; return (inch < 0.005 ? '0' : inch < 1 ? inch.toFixed(2) : inch.toFixed(1)) + '"'; }
  return (mm < 0.05 ? '0' : mm < 10 ? String(Math.round(mm * 10) / 10) : String(Math.round(mm))) + 'mm';
}
/* where the wind blows TO, for an arrow: the bearing it comes from + 180° */
export const windToward = (deg) => (Number.isFinite(deg) ? (((deg + 180) % 360) + 360) % 360 : null);

/* Yesterday's row from history[], when it is the day before forecast[0] */
export function yesterdayRow(history, forecast){
  const f0 = forecast && forecast[0];
  if (!history || !history.length || !f0) return null;
  const y = history[history.length - 1];
  const d = (Date.parse(y.date + 'T00:00:00Z') - Date.parse(f0.date + 'T00:00:00Z')) / 86400000;
  return d === -1 ? y : null;
}
/* Today's high against yesterday's in whole degrees of the unit on screen:
   +4 warmer, -2 cooler, 0 the same; null when either is missing */
export function vsYesterday(today, yesterday, fahrenheit){
  const a = fahrenheit ? today.maxtemp_f : today.maxtemp_c;
  const b = fahrenheit ? yesterday.maxtemp_f : yesterday.maxtemp_c;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(a) - Math.round(b);
}
/* A day's length in minutes from its "HH:MM" sunrise and sunset (null at
   the poles, where the proxy nulls them) */
export function dayLength(day){
  const m = (t) => { const x = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return x ? +x[1] * 60 + +x[2] : null; };
  const a = day && m(day.sunrise), b = day && m(day.sunset);
  return a != null && b != null && b > a ? b - a : null;
}
/* { minutes, delta, against: 'yesterday' | 'tomorrow' | null } — the turn
   of the season in minutes, against yesterday when the card holds it,
   else as tomorrow will be */
export function daylight(today, yesterday, tomorrow){
  const L = dayLength(today);
  if (L == null) return null;
  const Ly = yesterday ? dayLength(yesterday) : null, Lt = tomorrow ? dayLength(tomorrow) : null;
  if (Ly != null) return { minutes: L, delta: L - Ly, against: 'yesterday' };
  if (Lt != null) return { minutes: L, delta: Lt - L, against: 'tomorrow' };
  return { minutes: L, delta: null, against: null };
}
/* The air's make-up beside its band: [{ key, label, value }] in µg/m³,
   or [] when the reading has nothing beyond the particulates the band
   line already names */
export const POLLUTANTS = [['pm2_5', 'PM2.5'], ['pm10', 'PM10'], ['o3', 'O₃'], ['no2', 'NO₂'], ['so2', 'SO₂'], ['co', 'CO']];
export function pollutants(air){
  if (!air || air.index == null) return [];
  const out = POLLUTANTS.filter(([k]) => Number.isFinite(air[k])).map(([key, label]) => ({ key, label, value: air[key] }));
  return out.length > 2 ? out : [];
}

/* The daily rows: each day's low→high segment positioned inside the
   overall range of whatever is handed in (left/width in %, one decimal),
   so the bars line up as one shared thermometer. Past days are passed by
   concatenating them ahead of the forecast — sharing the scale is the
   point, since it is what makes a cold yesterday read as cold next to
   today. They stay a separate array until this call because forecast[0]
   is read as "today" elsewhere. */
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

/* ── the wind reading ────────────────────────────────────────────────
   The payload carries km/h and mph; the page lets the wind have a unit of
   its own because much of the world says m/s, and China and Japan a
   Beaufort force (3级). '' follows the °C/°F switch. */
export const WIND_UNITS = ['kmh', 'ms', 'bft', 'mph'];

/* The unit in force: the reader's pick when it is one of WIND_UNITS, else
   the temperature switch's (mph for °F, km/h for °C). */
export function windUnit(pick, fahrenheit){
  return WIND_UNITS.indexOf(pick) >= 0 ? pick : (fahrenheit ? 'mph' : 'kmh');
}
/* Pressing the reading steps km/h → m/s → force → mph → km/h. */
export function nextWindUnit(unit){
  return WIND_UNITS[(WIND_UNITS.indexOf(unit) + 1) % WIND_UNITS.length];
}

/* Beaufort force from km/h — the lower bound of each force from 1 to 12. */
export const BFT_KMH = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
export function beaufort(kph){
  let n = 0;
  while (n < BFT_KMH.length && kph >= BFT_KMH[n]) n++;
  return n;
}

/* Speed with its unit, in the given unit (see windUnit). mph is derived from
   km/h when the payload lacks it; m/s keeps one decimal; Beaufort is
   rendered by opts.force(n) ("Force 3" by default — the site i18n's it,
   3级 in Chinese). '—' when there is no reading. Works for the gust too. */
export function windSpeedStr(kph, mph, unit, opts){
  if (unit === 'mph'){
    if (mph == null && kph != null) mph = Math.round(kph * 0.6214 * 10) / 10;
    return mph != null ? mph + ' mph' : '—';
  }
  if (kph == null) return '—';
  if (unit === 'ms') return (kph / 3.6).toFixed(1) + ' m/s';
  if (unit === 'bft'){
    const n = beaufort(kph);
    return (opts && typeof opts.force === 'function') ? opts.force(n) : 'Force ' + n;
  }
  return kph + ' km/h';
}

/* 16 compass points, clockwise from north. The page injects the reader's
   language; a list that isn't 16 long is ignored. */
export const COMPASS16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
export function windDir16(deg, names){
  const list = (Array.isArray(names) && names.length === 16) ? names : COMPASS16;
  return list[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/* The direction the wind blows FROM, for a payload's `current`: taken from
   the bearing, which every provider reports, rather than upstream's label —
   one provider printed English "NNE" on every UI while another printed
   Chinese "东北风", so one panel read two ways depending on the city. The
   label is the fallback. A direction means nothing under ~1 km/h (calm is
   still reported as a bearing), so the page shows none below that. */
export function windDirStr(current, names){
  const deg = current && current.wind_deg;
  if (typeof deg === 'number' && isFinite(deg)) return windDir16(deg, names);
  return (current && current.wind_dir) ? String(current.wind_dir) : '';
}

/* Visibility on the temperature switch too: km, or miles for °F readers.
   Under 1 keeps a decimal, since 0.4 and 0 are very different fogs. '' when
   the payload has none. */
export function visStr(km, fahrenheit){
  if (km == null || !isFinite(km)) return '';
  const v = fahrenheit ? km * 0.621371 : km;
  return (v < 1 ? v.toFixed(1) : String(Math.round(v))) + (fahrenheit ? ' mi' : ' km');
}

/* ── favourites: place identity ──────────────────────────────────────
   A favourite is { name, country, lat?, lon? }. Its name is a DISPLAY
   string, localized by whichever language the city was searched in —
   never its identity: 東京 and Tokyo, 曼谷 and Bangkok each stood as two
   favourites. No provider-independent city id exists across the proxy's
   chain, so the one stable thing every response carries is the coordinate
   pair; two places within 0.05° are the same city (the same nearness
   mergeNominatimLead uses to fold two sources into one hit). */
export const SAME_PLACE_DEG = 0.05;

/* Coordinates as REAL numbers, or null. A stored favourite can carry
   numeric STRINGS (a hand-edited export), and the global isFinite('35.68')
   says true, so they are coerced here; out-of-range values are dropped
   rather than clamped — they are not a place. */
/* A number, or a NON-BLANK numeric string; '' and whitespace coerce to 0
   under Number(), which would plant every blank favourite at (0, 0) and
   fold them into one. Booleans and other types are not coordinates. */
function coordNum(v){
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) return Number(v);
  return NaN;
}
export function coordsOf(p){
  if (!p || p.lat == null || p.lon == null) return null;
  const la = coordNum(p.lat), lo = coordNum(p.lon);
  if (!isFinite(la) || !isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return { lat: la, lon: lo };
}
export function nearLoc(a, b){
  const x = coordsOf(a), y = coordsOf(b);
  return !!x && !!y && Math.abs(x.lat - y.lat) < SAME_PLACE_DEG && Math.abs(x.lon - y.lon) < SAME_PLACE_DEG;
}

/* Best known place for a favourite: its own coords when it carries them,
   else whatever `resolve(f)` knows — the page passes a lookup into its
   per-name weather cache (the location its card fetch resolved). A legacy
   entry with neither returns null, so identity then falls back to the name
   and nothing is ever merged without coordinate proof. */
export function favPlace(f, resolve){
  if (coordsOf(f)) return f;
  const loc = (typeof resolve === 'function') ? resolve(f) : null;
  return loc || null;
}

/* THE identity predicate — every same-city decision (star state, removal,
   dedupe, active card) goes through here so they can never disagree. When
   BOTH sides have coords, coords ALONE decide: two favourites may share a
   display name yet be different cities (Springfield IL/MO, Valencia ES/VE),
   and a name match must not merge — or delete — the other one. The name is
   only the identity of last resort while either side lacks coordinates.
   `ref` may be a favourite or a payload's location. */
export function favSame(f, ref, resolve){
  if (!f || !ref) return false;
  const a = favPlace(f, resolve), b = favPlace(ref, resolve);
  if (coordsOf(a) && coordsOf(b)) return nearLoc(a, b);
  return !!f.name && f.name === ref.name;
}
export function favMatch(favs, loc, resolve){
  if (!loc) return -1;
  for (let i = 0; i < favs.length; i++) if (favSame(favs[i], loc, resolve)) return i;
  return -1;
}

/* A new favourite from a payload's location: the display name plus the
   identity stamp, coords rounded to 4 decimals (~10 m). */
export function favEntry(loc){
  const entry = { name: loc.name, country: loc.country || '' };
  const c = coordsOf(loc);
  if (c){ entry.lat = Math.round(c.lat * 1e4) / 1e4; entry.lon = Math.round(c.lon * 1e4) / 1e4; }
  return entry;
}

/* One pass over a stored list: drop every entry that is the same place as
   an earlier one (the front is the most recent star — the latest choice of
   name wins), and stamp missing coords onto survivors so their identity
   stops depending on a warm cache. Stamping also normalizes numeric strings
   in place. Lists that collected duplicates before coords were stored heal
   on their next pass. → { favs, dropped, changed } */
export function dedupeFavs(favs, resolve){
  const out = [], dropped = [];
  let changed = false;
  for (const f of favs || []) {
    if (out.some(o => favSame(f, o, resolve))) { dropped.push(f); changed = true; continue; }
    const pc = coordsOf(favPlace(f, resolve));
    if (pc && (typeof f.lat !== 'number' || typeof f.lon !== 'number')) {
      f.lat = Math.round(pc.lat * 1e4) / 1e4;
      f.lon = Math.round(pc.lon * 1e4) / 1e4;
      changed = true;
    }
    out.push(f);
  }
  return { favs: out, dropped, changed };
}
