/* calendar-context.js — the date context the Calendar lays over its grid.
 *
 * A month of empty squares says nothing; these are the facts a date carries on
 * its own, with no account and no subscription behind them:
 *
 *   isoWeek / dayOfYear / daysInYear   where the date sits in its year
 *   moonPhaseTimes / moonState         the four principal phases as instants,
 *                                      and the lit fraction at any moment
 *   seasonTimes                        the two equinoxes and two solstices
 *   clockChanges                       daylight-saving switches in a zone
 *   classifyHolidays / holidayItems    which holiday-feed entries are days
 *                                      off, and runs of them merged
 *   monthDigest                        all of the above for one month
 *
 * The astronomy follows Jean Meeus, Astronomical Algorithms (2nd ed.):
 * chapter 49 for the phases (about a minute from the published times),
 * chapter 27 for the equinoxes and solstices (about a minute), chapter 47/48
 * for the Moon's illuminated fraction (a fraction of a percent). Instants are
 * returned as Unix milliseconds in UTC; dates are civil (year, month 0-11,
 * day) in whatever calendar the caller is drawing.
 *
 * No DOM, no storage, no network. */

var DAY_MS = 86400000;
var DEG = Math.PI / 180;
function sinD(x) { return Math.sin(x * DEG); }
function cosD(x) { return Math.cos(x * DEG); }
function norm360(x) { x %= 360; return x < 0 ? x + 360 : x; }

/* Midnight UTC of a civil date, for any year — Date.UTC maps 0-99 to
   1900-1999, which a calendar that pages back to year 1 cannot have. */
function utcDay(y, m, d) {
  var t = new Date(0);
  t.setUTCFullYear(y, m, d);
  return t.getTime();
}

/* ---------- where a date sits in its year ---------- */

/* ISO 8601: weeks start on Monday and week 1 is the one holding the year's
   first Thursday, so 29 December can be week 1 of the next year and
   3 January week 53 of the last. `year` is the week-numbering year. */
export function isoWeek(y, m, d) {
  var t = utcDay(y, m, d);
  var wd = (new Date(t).getUTCDay() + 6) % 7;            // Mon 0 … Sun 6
  var th = t + (3 - wd) * DAY_MS;                        // this week's Thursday
  var ty = new Date(th).getUTCFullYear();
  return { year: ty, week: 1 + Math.floor((th - utcDay(ty, 0, 1)) / (7 * DAY_MS)) };
}

export function daysInYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}

/* 1 on 1 January, 365 or 366 on 31 December. */
export function dayOfYear(y, m, d) {
  return Math.round((utcDay(y, m, d) - utcDay(y, 0, 1)) / DAY_MS) + 1;
}

/* ---------- time scales ---------- */

function jdOf(ms) { return ms / DAY_MS + 2440587.5; }
function msOf(jd) { return (jd - 2440587.5) * DAY_MS; }

/* ΔT = TT − UT in seconds (Espenak & Meeus polynomials, NASA eclipse pages).
   The ephemerides below run on Terrestrial Time; a clock runs on UT. Around
   now the difference is a little over a minute. */
export function deltaT(year) {
  var t;
  if (year >= 2005 && year < 2050) { t = year - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
  if (year >= 1986 && year < 2005) {
    t = year - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t + 0.000651814 * t * t * t * t + 0.00002373599 * t * t * t * t * t;
  }
  if (year >= 2050 && year < 2150) { t = (year - 1820) / 100; return -20 + 32 * t * t - 0.5628 * (2150 - year); }
  if (year >= 1961 && year < 1986) { t = year - 1975; return 45.45 + 1.067 * t - t * t / 260 - t * t * t / 718; }
  if (year >= 1941 && year < 1961) { t = year - 1950; return 29.07 + 0.407 * t - t * t / 233 + t * t * t / 2547; }
  if (year >= 1920 && year < 1941) { t = year - 1920; return 21.20 + 0.84493 * t - 0.0761 * t * t + 0.0020936 * t * t * t; }
  if (year >= 1900 && year < 1920) {
    t = year - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t * t * t - 0.000197 * t * t * t * t;
  }
  t = (year - 1820) / 100;
  return -20 + 32 * t * t;
}
function yearOf(ms) { return 1970 + ms / (365.2425 * DAY_MS); }
function ttToUt(jde) { return msOf(jde) - deltaT(yearOf(msOf(jde))) * 1000; }

/* ---------- the Moon ---------- */

export var PHASE_NEW = 0, PHASE_FIRST = 1, PHASE_FULL = 2, PHASE_LAST = 3;

/* Meeus 49: the true phase for k = integer (new), +.25 (first quarter),
   +.5 (full), +.75 (last quarter), k = 0 being the new moon of 6 Jan 2000.
   Returns JDE (Terrestrial Time). */
function phaseJde(k) {
  var T = k / 1236.85, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  var jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4;
  var E = 1 - 0.002516 * T - 0.0000074 * T2, E2 = E * E;
  var M = norm360(2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3);
  var Mp = norm360(201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4);
  var F = norm360(160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4);
  var Om = norm360(124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3);
  var q = Math.round((k - Math.floor(k)) * 4) % 4, c;
  if (q === 0 || q === 2) {
    var f = q === 2;
    c = (f ? -0.40614 : -0.4072) * sinD(Mp) + (f ? 0.17302 : 0.17241) * E * sinD(M) +
        (f ? 0.01614 : 0.01608) * sinD(2 * Mp) + (f ? 0.01043 : 0.01039) * sinD(2 * F) +
        (f ? 0.00734 : 0.00739) * E * sinD(Mp - M) + (f ? -0.00515 : -0.00514) * E * sinD(Mp + M) +
        (f ? 0.00209 : 0.00208) * E2 * sinD(2 * M) - 0.00111 * sinD(Mp - 2 * F) - 0.00057 * sinD(Mp + 2 * F) +
        0.00056 * E * sinD(2 * Mp + M) - 0.00042 * sinD(3 * Mp) + 0.00042 * E * sinD(M + 2 * F) +
        0.00038 * E * sinD(M - 2 * F) - 0.00024 * E * sinD(2 * Mp - M) - 0.00017 * sinD(Om) -
        0.00007 * sinD(Mp + 2 * M) + 0.00004 * sinD(2 * Mp - 2 * F) + 0.00004 * sinD(3 * M) +
        0.00003 * sinD(Mp + M - 2 * F) + 0.00003 * sinD(2 * Mp + 2 * F) - 0.00003 * sinD(Mp + M + 2 * F) +
        0.00003 * sinD(Mp - M + 2 * F) - 0.00002 * sinD(Mp - M - 2 * F) - 0.00002 * sinD(3 * Mp + M) +
        0.00002 * sinD(4 * Mp);
  } else {
    c = -0.62801 * sinD(Mp) + 0.17172 * E * sinD(M) - 0.01183 * E * sinD(Mp + M) + 0.00862 * sinD(2 * Mp) +
        0.00804 * sinD(2 * F) + 0.00454 * E * sinD(Mp - M) + 0.00204 * E2 * sinD(2 * M) - 0.0018 * sinD(Mp - 2 * F) -
        0.0007 * sinD(Mp + 2 * F) - 0.0004 * sinD(3 * Mp) - 0.00034 * E * sinD(2 * Mp - M) +
        0.00032 * E * sinD(M + 2 * F) + 0.00032 * E * sinD(M - 2 * F) - 0.00028 * E2 * sinD(Mp + 2 * M) +
        0.00027 * E * sinD(2 * Mp + M) - 0.00017 * sinD(Om) - 0.00005 * sinD(Mp - M - 2 * F) +
        0.00004 * sinD(2 * Mp + 2 * F) - 0.00004 * sinD(Mp + M + 2 * F) + 0.00004 * sinD(Mp - 2 * M) +
        0.00003 * sinD(Mp + M - 2 * F) + 0.00003 * sinD(3 * M) + 0.00002 * sinD(2 * Mp - 2 * F) +
        0.00002 * sinD(Mp - M + 2 * F) - 0.00002 * sinD(3 * Mp + M);
    var W = 0.00306 - 0.00038 * E * cosD(M) + 0.00026 * cosD(Mp) - 0.00002 * cosD(Mp - M) +
            0.00002 * cosD(Mp + M) + 0.00002 * cosD(2 * F);
    c += q === 1 ? W : -W;
  }
  /* the planetary arguments, common to all four phases */
  var A = [299.77 + 0.107408 * k - 0.009173 * T2, 251.88 + 0.016321 * k, 251.83 + 26.651886 * k,
           349.42 + 36.412478 * k, 84.66 + 18.206239 * k, 141.74 + 53.303771 * k, 207.14 + 2.453732 * k,
           154.84 + 7.30686 * k, 34.52 + 27.261239 * k, 207.19 + 0.121824 * k, 291.34 + 1.844379 * k,
           161.72 + 24.198154 * k, 239.56 + 25.513099 * k, 331.55 + 3.592518 * k];
  var AC = [0.000325, 0.000165, 0.000164, 0.000126, 0.00011, 0.000062, 0.00006, 0.000056, 0.000047,
            0.000042, 0.00004, 0.000037, 0.000035, 0.000023];
  for (var i = 0; i < 14; i++) c += AC[i] * sinD(A[i]);
  return jde + c;
}

/* Every principal phase with fromMs <= ms < toMs, oldest first:
   [{ phase: PHASE_NEW|PHASE_FIRST|PHASE_FULL|PHASE_LAST, ms }]. */
export function moonPhaseTimes(fromMs, toMs) {
  var out = [];
  if (!(toMs > fromMs)) return out;
  var k = Math.floor((yearOf(fromMs) - 2000) * 12.3685 * 4) / 4 - 0.5;
  for (var guard = 0; guard < 20000; guard++, k += 0.25) {
    var ms = ttToUt(phaseJde(k));
    if (ms >= toMs) break;
    if (ms >= fromMs) out.push({ phase: Math.round((k - Math.floor(k)) * 4) % 4, ms: Math.round(ms) });
  }
  return out;
}

/* The Moon at one instant (Meeus 48.4 over the chapter 47 mean arguments):
   illum   the illuminated fraction of the disc, 0…1
   elong   its elongation from the Sun in degrees, 0 at new, 180 at full —
           under 180 it is waxing
   phase8  0 new · 1 waxing crescent · 2 first quarter · 3 waxing gibbous ·
           4 full · 5 waning gibbous · 6 last quarter · 7 waning crescent,
           by elongation (each principal phase owns ±1/16 of the cycle). A
           calendar that wants "the day of the full moon" should ask
           moonPhaseTimes() for the instant instead. */
export function moonState(ms) {
  var jde = jdOf(ms) + deltaT(yearOf(ms)) / 86400;
  var T = (jde - 2451545) / 36525, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  var D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
  var M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
  var Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
  var i = 180 - D - 6.289 * sinD(Mp) + 2.1 * sinD(M) - 1.274 * sinD(2 * D - Mp) -
          0.658 * sinD(2 * D) - 0.214 * sinD(2 * Mp) - 0.11 * sinD(D);
  var elong = norm360(180 - i);
  return {
    illum: (1 + cosD(i)) / 2,
    elong: elong,
    waxing: elong < 180,
    phase8: Math.floor(norm360(elong + 22.5) / 45) % 8
  };
}

/* A calendar day's name for the Moon, as an index into the eight phases:
   the principal phase only on the day its instant falls in (pass that
   phase, or null), otherwise crescent or gibbous by the day's own state —
   the day before a new moon is a waning crescent, not "new moon". */
export function phaseOfDay(principal, state) {
  if (principal != null) return (typeof principal === 'object' ? principal.phase : principal) * 2;
  return state.waxing ? (state.illum < 0.5 ? 1 : 3) : (state.illum < 0.5 ? 7 : 5);
}

/* ---------- equinoxes and solstices ---------- */

export var MARCH_EQUINOX = 0, JUNE_SOLSTICE = 1, SEPTEMBER_EQUINOX = 2, DECEMBER_SOLSTICE = 3;

/* Meeus 27, valid 1000-3000: the mean instant, then 24 periodic terms. */
var SEASON_TERMS = [
  [485, 324.96, 1934.136], [203, 337.23, 32964.467], [199, 342.08, 20.186], [182, 27.85, 445267.112],
  [156, 73.14, 45036.886], [136, 171.52, 22518.443], [77, 222.54, 65928.934], [74, 296.72, 3034.906],
  [70, 243.58, 9037.513], [58, 119.81, 33718.147], [52, 297.17, 150.678], [50, 21.02, 2281.226],
  [45, 247.54, 29929.562], [44, 325.15, 31555.956], [29, 60.93, 4443.417], [18, 155.12, 67555.328],
  [17, 288.79, 4562.452], [16, 198.04, 62894.029], [14, 199.76, 31436.921], [12, 95.39, 14577.848],
  [12, 287.11, 31931.756], [12, 320.81, 34777.259], [9, 227.73, 1222.114], [8, 15.45, 16859.074]
];
var SEASON_MEAN = [
  [2451623.80984, 365242.37404, 0.05169, -0.00411, -0.00057],
  [2451716.56767, 365241.62603, 0.00325, 0.00888, -0.0003],
  [2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078],
  [2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032]
];

/* The year's four instants, in order: [{ kind, ms }]. kind is one of the
   constants above — named by month, not by season, because the same instant
   starts spring in one hemisphere and autumn in the other. Empty outside
   1000-3000, where the polynomials stop being worth printing. */
export function seasonTimes(year) {
  if (!(year >= 1000 && year <= 3000)) return [];
  var Y = (year - 2000) / 1000, out = [];
  for (var s = 0; s < 4; s++) {
    var p = SEASON_MEAN[s];
    var jde0 = p[0] + p[1] * Y + p[2] * Y * Y + p[3] * Y * Y * Y + p[4] * Y * Y * Y * Y;
    var T = (jde0 - 2451545) / 36525;
    var W = 35999.373 * T - 2.47;
    var dl = 1 + 0.0334 * cosD(W) + 0.0007 * cosD(2 * W);
    var S = 0;
    for (var i = 0; i < SEASON_TERMS.length; i++) S += SEASON_TERMS[i][0] * cosD(SEASON_TERMS[i][1] + SEASON_TERMS[i][2] * T);
    out.push({ kind: s, ms: Math.round(ttToUt(jde0 + 0.00001 * S / dl)) });
  }
  return out;
}

/* ---------- daylight-saving switches ---------- */

/* Minutes east of UTC at an instant, in an IANA zone (or the runtime's own
   zone when tz is empty). */
var ZONE_FMT = new Map();   // building a formatter costs far more than using one
export function zoneOffset(ms, tz) {
  if (!tz) return -new Date(ms).getTimezoneOffset();
  try {
    var f = ZONE_FMT.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short'
      });
      ZONE_FMT.set(tz, f);
    }
    var v = {};
    f.formatToParts(new Date(ms)).forEach(function (x) { v[x.type] = x.type === 'era' ? x.value : +x.value; });
    /* Date.UTC folds years 0-99 onto 1900-1999: the year is stamped after */
    var wall = new Date(Date.UTC(2000, v.month - 1, v.day, v.hour % 24, v.minute, v.second));
    wall.setUTCFullYear(/^B/.test(v.era || '') ? 1 - v.year : v.year);
    return Math.round((wall.getTime() - Math.floor(ms / 1000) * 1000) / 60000);
  } catch (_) { return -new Date(ms).getTimezoneOffset(); }
}

/* Every switch with fromMs < ms <= toMs: [{ ms, before, after, delta }] —
   ms the first instant on the new offset, before/after minutes east of UTC,
   delta = after − before (+60: clocks go forward an hour). The wall clock
   jumps from (ms + before) to (ms + after), each read as UTC fields. */
export function clockChanges(fromMs, toMs, tz) {
  var out = [], STEP = 6 * 3600000;
  var prevMs = fromMs, prev = zoneOffset(fromMs, tz);
  for (var t = fromMs; t < toMs;) {
    t = Math.min(t + STEP, toMs);
    var o = zoneOffset(t, tz);
    if (o !== prev) {
      /* bisect to the second; zones switch on a whole minute */
      var lo = prevMs, hi = t;
      while (hi - lo > 1000) {
        var mid = Math.floor((lo + hi) / 2);
        if (zoneOffset(mid, tz) === prev) lo = mid; else hi = mid;
      }
      out.push({ ms: Math.floor(hi / 60000) * 60000, before: prev, after: o, delta: o - prev });
      prev = o;
    }
    prevMs = t;
  }
  return out;
}

/* ---------- public holidays ---------- */

/* Google's public holiday calendars put the kind of each day in its
   DESCRIPTION, in the feed's language: "Public holiday" / "Observance",
   "公众假期" / "节假日", "祝日" / "祭日", "Gesetzlicher Feiertag" /
   "Gedenktag". Two things hold in every language checked (en, zh, zh-TW,
   ja, ko, de, fr, es, pt, ru, hi):
     · an observance's description carries a second line telling you how to
       hide observances in Google Calendar — it names Google; a holiday's
       never does;
     · the national public holiday is the most common first line among the
       rest; a different first line is a regional one ("Public holiday in
       District of Columbia", "Feiertag in Bayern").
   A holiday with a note under it ("Halbtägiger Feiertag", "这是半天假。") is
   a partial day. Sets ev.hk on every event:
     'p' public · 'h' partial · 'r' regional · 'o' observance.
   Events with no description at all read as public — the feed then says
   nothing, and saying everything is a holiday is what it did before. */
export function classifyHolidays(events) {
  var count = {}, top = '', best = -1;
  function first(d) { return String(d || '').split('\n')[0].trim(); }
  events.forEach(function (ev) {
    var d = ev && ev.desc;
    if (!d || /Google/.test(d)) return;
    var l = first(d);
    count[l] = (count[l] || 0) + 1;
  });
  Object.keys(count).forEach(function (l) { if (count[l] > best) { best = count[l]; top = l; } });
  events.forEach(function (ev) {
    if (!ev) return;
    var d = String(ev.desc || '');
    ev.hk = !d ? 'p' : /Google/.test(d) ? 'o' : first(d) !== top ? 'r' : d.indexOf('\n') >= 0 ? 'h' : 'p';
  });
  return events;
}

/* YYYY-MM-DD keys, the calendar's own currency. */
export function dayKey(y, m, d) {
  var t = new Date(utcDay(y, m, d));
  return String(t.getUTCFullYear()).padStart(4, '0') + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' +
         String(t.getUTCDate()).padStart(2, '0');
}
function keyIdx(k) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || '');
  return m ? Math.round(utcDay(+m[1], +m[2] - 1, +m[3]) / DAY_MS) : null;
}
function idxKey(i) { var t = new Date(i * DAY_MS); return dayKey(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); }

/* Holiday-feed instances → what a reader means by "the holidays":
   instances  [{ k: 'YYYY-MM-DD', n: days, t: title, hk }] — one per
              occurrence, as the Calendar's own instance list holds them
   Returns    [{ k, end, n, titles: [..], kind }] oldest first, where
              consecutive public days are ONE item (China's National Day
              is 国庆节 + six days of 黄金周 (国庆节): one seven-day run)
              and partial and regional days stand alone. Observances are
              left out — they are on the grid, but nobody gets them off.
   Titles that only repeat another title in brackets ("黄金周 (国庆节)")
   are folded into it. Weekends are NOT added to a run: feeds do not list
   the make-up working days some countries trade for long breaks, so
   "the weekend is off too" is not something this can know. */
export function holidayItems(instances, fromKey, toKey) {
  var lo = keyIdx(fromKey), hi = keyIdx(toKey), days = {};
  if (lo == null || hi == null) return [];
  instances.forEach(function (it) {
    if (!it || it.hk === 'o') return;
    var s = keyIdx(it.k);
    if (s == null) return;
    for (var i = Math.max(s, lo); i <= Math.min(s + Math.max(1, it.n || 1) - 1, hi); i++) (days[i] = days[i] || []).push(it);
  });
  var out = [], run = null;
  Object.keys(days).map(Number).sort(function (a, b) { return a - b; }).forEach(function (i) {
    var list = days[i], full = list.filter(function (it) { return it.hk !== 'r' && it.hk !== 'h'; });
    if (full.length) {
      if (run && run.last === i - 1) { run.last = i; run.n++; }
      else { run = { k: idxKey(i), last: i, n: 1, titles: [], kind: 'p' }; out.push(run); }
      full.forEach(function (it) { if (run.titles.indexOf(it.t) < 0) run.titles.push(it.t); });
    } else run = null;
    /* part-day and regional entries stand alone, on a public holiday too */
    list.forEach(function (it) {
      if (it.hk === 'r' || it.hk === 'h') out.push({ k: idxKey(i), last: i, n: 1, titles: [it.t], kind: it.hk });
    });
  });
  /* "黄金周 (国庆节)" only points at another title in brackets: folded into it.
     A title that merely contains another ("Second Christmas Day") stays. */
  function refersTo(t, o) {
    return ['()', '\uff08\uff09', '[]', '\u3010\u3011'].some(function (b) {
      return t.split(b[0]).slice(1).some(function (part) {
        var j = part.indexOf(b[1]);
        return j >= 0 && part.slice(0, j).trim() === o;
      });
    });
  }
  return out.map(function (r) {
    var titles = r.titles.filter(function (t, j) {
      return !r.titles.some(function (o, x) { return x !== j && o && t !== o && refersTo(t, o); });
    });
    return { k: r.k, end: idxKey(r.last), n: r.n, titles: titles.length ? titles : r.titles.slice(0, 1), kind: r.kind };
  });
}

/* ---------- one month ---------- */

/* Everything above for one civil month (m 0-11), with day keys in the zone
   tz (the runtime's own when empty):
     weeks    [first, last] ISO week numbers its days fall in
     days     its length
     moon     [{ phase, ms, k }]   principal phases whose local date is in it
     seasons  [{ kind, ms, k }]    an equinox or solstice, if it has one
     clocks   [{ ms, before, after, delta, k }]   daylight-saving switches
   The holiday part needs a feed, so it is holidayItems() on the caller's
   instances, not something a date can compute on its own. */
export function monthDigest(y, m, tz) {
  var first = utcDay(y, m, 1), next = utcDay(y, m + 1, 1);
  var len = Math.round((next - first) / DAY_MS);
  /* the month's instants are local: widen the UTC window by a day each side
     and keep what lands inside once read in the zone */
  var from = first - DAY_MS, to = next + DAY_MS;
  function localKey(ms) {
    var t = new Date(ms + zoneOffset(ms, tz) * 60000);
    return dayKey(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  }
  var lo = dayKey(y, m, 1), hi = dayKey(y, m, len);
  function inMonth(x) { x.k = localKey(x.ms); return x.k >= lo && x.k <= hi; }
  var w1 = isoWeek(y, m, 1).week, w2 = isoWeek(y, m, len).week;
  return {
    weeks: [w1, w2],
    days: len,
    moon: moonPhaseTimes(from, to).filter(inMonth),
    seasons: seasonTimes(y).filter(inMonth),
    clocks: clockChanges(from, to, tz).filter(inMonth)
  };
}
