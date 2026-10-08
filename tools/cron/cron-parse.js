/* Cron expression parser — logic of the Cron Expression tab on
   subnsub.com, kept in lockstep with the in-page version.

   Classic 5-field cron: minute hour day-of-month month day-of-week.
   Each field takes lists, ranges, steps and * — "1-5", "0,30", "9-17/2",
   "*" with "/15" for an every-15 step, and "5/15" for "from 5, every 15".
   Months and weekdays also take their English names in any case
   ("JAN-MAR", "mon-fri"). Day-of-week runs 0-6 with 7 accepted as Sunday,
   and wrap-around weekday ranges like "5-1" expand across the week
   boundary. The shortcuts @yearly (@annually), @monthly, @weekly, @daily
   (@midnight) and @hourly stand for their five fields.

   Anything else is an error that says which field and which token — never
   a silently shorter schedule: an out-of-range value, a reversed range, a
   zero step, Quartz/AWS syntax (a seconds field, ?, L, W, #) and @reboot,
   which runs once at startup and has no schedule to show.

   Day matching follows Vixie cron (cronie and most Linux crons): when
   either day field begins with "*", BOTH must match — so a bare "*"
   leaves the other one in charge and a stepped one ("*" + "/2") narrows
   it; when both are restricted, a date matches if EITHER does.

   Runs are computed on the wall clock of a time zone (the runtime's own
   by default) and converted to instants, the way a crontab on a machine
   in that zone fires. Around a daylight-saving switch cron (Vixie,
   cronie) splits jobs in two. A job whose minute or hour field begins
   with "*" (and @hourly) is a wildcard job and simply runs by the new
   clock: nothing for a skipped stretch, and again in a repeated hour —
   the second pass is reported with again: true. Any other job is
   fixed-time: each run the clocks skip is reported at the switch with
   gap: true (cron runs it as the clocks move), and a wall time that
   happens twice runs once, at its first occurrence, with fold: true.

   Pure computation: no DOM, no network, no storage. */

const CRON_MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CRON_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DAY_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

export const CRON_MACROS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *'
};
/* field order, bounds and the names each accepts */
export const CRON_FIELDS = [
  { key: 'min', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dom', min: 1, max: 31 },
  { key: 'mon', min: 1, max: 12, names: MONTH_NAMES },
  { key: 'dow', min: 0, max: 7, names: DAY_NAMES, wrap: 7 }
];

/* One field → { values: sorted list, star } or { error }. */
function parseField(text, f) {
  const out = new Set();
  const fail = (code, token) => ({ error: { code, field: f.key, token } });
  const num = (s) => {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (f.names && Object.prototype.hasOwnProperty.call(f.names, s.toUpperCase())) return f.names[s.toUpperCase()];
    return null;
  };
  for (const part of text.split(',')) {
    if (!part) return fail('token', text);
    if (/[?#]/.test(part) || /^(L|LW|\d*L|\d+W|L-\d+)$/i.test(part)) return fail('quartz', part);
    let base = part, step = 1;
    const sm = /^(.*)\/(.*)$/.exec(part);
    if (sm) {
      if (!/^\d+$/.test(sm[2]) || +sm[2] < 1) return fail('step', part);
      base = sm[1]; step = +sm[2];
    }
    let lo, hi;
    if (base === '*') { lo = f.min; hi = f.key === 'dow' ? 6 : f.max; }
    else {
      const rm = /^([^-]+)-([^-]+)$/.exec(base);
      if (rm) {
        lo = num(rm[1]); hi = num(rm[2]);
        if (lo == null || hi == null) return fail('token', part);
      } else {
        lo = num(base);
        if (lo == null) return fail('token', part);
        /* "5/15": from 5 to the top, every 15 (Vixie); a bare value is itself */
        hi = sm ? (f.key === 'dow' ? 6 : f.max) : lo;
      }
      if (lo < f.min || lo > f.max || hi < f.min || hi > f.max) return fail('range', part);
      if (lo > hi && !f.wrap) return fail('range', part);
    }
    if (f.wrap && lo > hi) {
      /* a weekday range across Sunday: 5-1 is Fri, Sat, Sun, Mon */
      for (let i = lo; i <= hi + f.wrap; i += step) out.add(i % f.wrap);
    } else {
      for (let i = lo; i <= hi; i += step) out.add(f.wrap && i === f.wrap ? 0 : i);
    }
  }
  return { values: [...out].sort((a, b) => a - b), star: text.charAt(0) === '*' };
}

/* expr → { ok: true, fields: { min, hour, dom, mon, dow } (sorted value
   lists), raw: [five strings], macro, domStar, dowStar, wild }
   (wild: the minute or hour field begins with "*" — see above)
        | { ok: false, error: { code, field?, token? } }
   codes: fields (not five), token, range, step, quartz, reboot, macro */
export function cronParse(expr) {
  let s = String(expr == null ? '' : expr).trim().replace(/\s+/g, ' ');
  let macro = null;
  if (s.charAt(0) === '@') {
    const k = s.toLowerCase();
    if (k === '@reboot') return { ok: false, error: { code: 'reboot', token: s } };
    if (!CRON_MACROS[k]) return { ok: false, error: { code: 'macro', token: s } };
    macro = k; s = CRON_MACROS[k];
  }
  const raw = s ? s.split(' ') : [];
  if (raw.length !== 5) return { ok: false, error: { code: 'fields', token: String(raw.length) } };
  const fields = {};
  let domStar = false, dowStar = false, wild = false;
  for (let i = 0; i < 5; i++) {
    const r = parseField(raw[i], CRON_FIELDS[i]);
    if (r.error) return { ok: false, error: r.error };
    fields[CRON_FIELDS[i].key] = r.values;
    if (i < 2 && r.star) wild = true;
    if (i === 2) domStar = r.star;
    if (i === 4) dowStar = r.star;
  }
  return { ok: true, fields, raw, macro, domStar, dowStar, wild };
}

/* Expand one field into its sorted values (min..max; wrapAt 7 for
   weekdays). Kept for callers of the earlier API; malformed input yields
   [] here — cronParse() is the one that says what is wrong. */
export function cronExpand(field, min, max, wrapAt) {
  const f = CRON_FIELDS.find(x => x.min === min && (x.max === max || (x.key === 'dow' && max === 6))) || { key: 'x', min, max };
  const r = parseField(String(field), wrapAt ? CRON_FIELDS[4] : f);
  return r.error ? [] : r.values.filter(n => n >= min && n <= max);
}

/* Does a civil date (month 1-12, day, weekday 0 Sunday) match the day
   fields, by Vixie's star rule above? */
export function cronDayMatch(p, m, d, wd) {
  if (p.fields.mon.indexOf(m) < 0) return false;
  const dm = p.fields.dom.indexOf(d) >= 0, wm = p.fields.dow.indexOf(wd) >= 0;
  return (p.domStar || p.dowStar) ? (dm && wm) : (dm || wm);
}

/* ---------- describing ---------- */

/* Runs of three or more consecutive values collapse: [1,2,3,4,5,9] → "1–5, 9". */
export function cronRanges(values, label) {
  const lab = label || String, out = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    if (j - i >= 2) out.push(lab(values[i]) + '–' + lab(values[j]));
    else for (let k = i; k <= j; k++) out.push(lab(values[k]));
    i = j + 1;
  }
  return out.join(', ');
}
/* a field that is "every n from its start": the step, else 0 */
function everyStep(values, min, count) {
  if (values.length < 2 || values[0] !== min) return 0;
  const s = values[1] - values[0];
  for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] !== s) return 0;
  return values.length === Math.ceil(count / s) ? s : 0;
}
const pad2 = (n) => (n < 10 ? '0' : '') + n;

/* Plain-language description. t(key, english, vars) translates; the
   default is English. Returns null when expr does not parse. */
export function cronDescribe(expr, t) {
  const tr = t || ((k, fb, v) => { let s = fb; for (const n in v || {}) s = s.split('{' + n + '}').join(v[n]); return s; });
  const p = typeof expr === 'object' && expr && expr.ok ? expr : cronParse(expr);
  if (!p.ok) return null;
  const F = p.fields, parts = [];
  const allMin = F.min.length === 60, allHour = F.hour.length === 24;
  const mStep = everyStep(F.min, 0, 60), hStep = everyStep(F.hour, 0, 24);
  let what;
  if (allMin) what = tr('cron.everyMinute', 'every minute');
  else if (mStep) what = tr('cron.everyNMin', 'every {n} minutes', { n: mStep });
  else if (F.min.length === 1 && allHour) what = tr('cron.atMinute', 'at minute {m}', { m: F.min[0] });
  else what = tr('cron.atMinutes', 'at minutes {list} past the hour', { list: cronRanges(F.min, v => ':' + pad2(v)) });
  if (!allHour) {
    if (F.min.length * F.hour.length <= 6 && !allMin && !mStep) {
      const times = [];
      for (const h of F.hour) for (const m of F.min) times.push(pad2(h) + ':' + pad2(m));
      what = tr('cron.atTimes', 'at {times}', { times: times.join(', ') });
    } else if (hStep && F.min.length === 1 && F.min[0] === 0) {
      what = tr('cron.everyNHour', 'every {n} hours', { n: hStep });
    } else {
      const h0 = F.hour[0], h1 = F.hour[F.hour.length - 1];
      what = (h1 - h0 + 1 === F.hour.length)
        ? tr('cron.between', '{what}, between {a} and {b}', { what, a: pad2(h0) + ':00', b: pad2(h1) + ':59' })
        : tr('cron.inHours', '{what}, during hours {list}', { what, list: cronRanges(F.hour, pad2) });
    }
  }
  parts.push(what);
  const dayLab = (d) => tr('cron.dow.' + d, CRON_DAYS[d]);
  const domAll = F.dom.length === 31, dowAll = F.dow.length === 7;
  if (!(p.domStar || p.dowStar)) {
    /* either day may match: one field that covers every day makes it every day */
    if (!domAll && !dowAll) parts.push(tr('cron.onDayOrDows', 'on day {dom} of the month or on {days}', { dom: cronRanges(F.dom), days: cronRanges(F.dow, dayLab) }));
  } else {
    if (!domAll) parts.push(tr('cron.onDayOfMonth', 'on day {d} of the month', { d: cronRanges(F.dom) }));
    if (!dowAll) parts.push(tr('cron.onDays', 'on {days}', { days: cronRanges(F.dow, dayLab) }));
  }
  if (F.mon.length !== 12) parts.push(tr('cron.inMonths', 'in {months}', { months: cronRanges(F.mon, m => tr('cron.mon.' + m, CRON_MONTHS[m])) }));
  return parts.join(tr('cron.sep', ', ')).replace(/^./, c => c.toUpperCase());
}

/* ---------- running it ---------- */

/* Minutes east of UTC at an instant, in an IANA zone (the runtime's own
   when tz is empty). */
const ZONE_FMT = new Map();   // building a formatter costs far more than using one
export function cronZoneOffset(ms, tz) {
  if (!tz) return -new Date(ms).getTimezoneOffset();
  let f = ZONE_FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    });
    ZONE_FMT.set(tz, f);
  }
  const p = {};
  f.formatToParts(new Date(ms)).forEach(x => { p[x.type] = +x.value; });
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60000);
}

/* Wall clock (as UTC fields of `wall`) → the instant(s) it names in tz.
   Offsets are cached per hour of instant: they only change on a switch. */
function makeResolver(tz) {
  const cache = new Map();
  const off = (ms) => {
    const h = Math.floor(ms / 3600000);
    let v = cache.get(h);
    if (v === undefined) { v = cronZoneOffset(h * 3600000 + 1800000, tz); if (cache.size > 20000) cache.clear(); cache.set(h, v); }
    /* the half-hour probe misses a switch inside this hour: check the edges */
    return v;
  };
  const exact = (ms) => cronZoneOffset(ms, tz);
  return function resolve(wall) {
    const a = off(wall - 18 * 3600000), b = off(wall + 18 * 3600000);
    /* no switch within 18 hours either side: one offset, one instant */
    if (a === b) return { ms: wall - a * 60000 };
    const cands = [];
    for (const o of [a, b]) {
      const ms = wall - o * 60000;
      if (exact(ms) === o) cands.push(ms);
    }
    cands.sort((x, y) => x - y);
    if (cands.length === 1) return { ms: cands[0] };
    if (cands.length > 1) return { ms: cands[0], ms2: cands[1], fold: true };
    /* skipped by the clocks: the switch itself is the first instant on the
       new offset at or after this wall time read on the old one */
    let lo = wall - a * 60000 - 3 * 3600000, hi = wall - a * 60000;
    while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2); if (exact(mid) === a) lo = mid; else hi = mid; }
    return { ms: Math.floor(hi / 60000) * 60000, gap: true };
  };
}

/* The next `count` runs after `from` (a Date or ms; now by default) in the
   zone tz: [{ ms, wall: Date (its UTC fields are the wall clock), gap?,
   fold?, again? }] in time order. Stops early once `untilMs` is passed or
   the search budget is spent (an impossible schedule like "0 0 31 2 *"
   returns []). */
export function cronRuns(expr, count, from, tz, untilMs) {
  const p = typeof expr === 'object' && expr && expr.ok ? expr : cronParse(expr);
  if (!p.ok) return [];
  const F = p.fields, n = count == null ? 10 : count, out = [], wild = !!p.wild;
  const fromMs = from == null ? Date.now() : +from;
  const resolve = makeResolver(tz || '');
  /* a wildcard job's second pass through a repeated hour waits its turn */
  const later = [];
  const push = (run) => {
    while (later.length && later[0].ms < run.ms && out.length < n) out.push(later.shift());
    if (out.length < n) out.push(run);
  };
  /* the first wall minute after `from` — read on the later offset when the
     clocks are about to go back, so a repeated hour's second pass is seen */
  const startOff = Math.min(cronZoneOffset(fromMs, tz || ''), cronZoneOffset(fromMs + 3 * 3600000, tz || ''));
  let w = Math.floor((fromMs + startOff * 60000) / 60000) * 60000 + 60000;
  let budget = 2e6;
  const minSet = new Set(F.min), hourSet = new Set(F.hour);
  while (out.length < n && budget-- > 0) {
    const t = new Date(w);
    const y = t.getUTCFullYear(), mo = t.getUTCMonth(), d = t.getUTCDate(), h = t.getUTCHours(), mi = t.getUTCMinutes();
    if (y > 9999) break;
    if (F.mon.indexOf(mo + 1) < 0) { w = Date.UTC(y, mo + 1, 1); continue; }
    if (!cronDayMatch(p, mo + 1, d, t.getUTCDay())) { w = Date.UTC(y, mo, d + 1); continue; }
    if (!hourSet.has(h)) {
      const nh = F.hour.find(x => x > h);
      w = nh == null ? Date.UTC(y, mo, d + 1) : Date.UTC(y, mo, d, nh, F.min[0]);
      continue;
    }
    if (!minSet.has(mi)) {
      const nm = F.min.find(x => x > mi);
      w = nm == null ? Date.UTC(y, mo, d, h + 1) : Date.UTC(y, mo, d, h, nm);
      continue;
    }
    const r = resolve(w);
    if (untilMs != null && r.ms > untilMs) break;
    if (r.gap) {
      /* skipped by the clocks: a fixed-time job runs as they move */
      if (!wild && r.ms > fromMs) push({ ms: r.ms, wall: new Date(w), gap: true });
    } else if (r.fold && wild) {
      if (r.ms > fromMs) push({ ms: r.ms, wall: new Date(w) });
      if (r.ms2 > fromMs) later.push({ ms: r.ms2, wall: new Date(w), again: true });
    } else if (r.ms > fromMs) {
      push(r.fold ? { ms: r.ms, wall: new Date(w), fold: true } : { ms: r.ms, wall: new Date(w) });
    }
    w += 60000;
  }
  while (later.length && out.length < n && (untilMs == null || later[0].ms <= untilMs)) out.push(later.shift());
  return out;
}

/* The next `count` fire times as Dates in the runtime's zone (the earlier
   API); pass tz for another zone. */
export function cronNext(expr, count, from, tz) {
  return cronRuns(expr, count == null ? 10 : count, from, tz).map(r => new Date(r.ms));
}

/* How often over the next `days` (30) from `from`, in zone tz:
   { runs, perDay, minGap, maxGap (ms), heat: 7×24 counts by the wall
     clock's weekday (0 Sunday) and hour over the first 28 days, capped }
   minGap / maxGap are null with fewer than two runs. */
export function cronStats(expr, from, tz, days) {
  const p = typeof expr === 'object' && expr && expr.ok ? expr : cronParse(expr);
  if (!p.ok) return null;
  const fromMs = from == null ? Date.now() : +from, span = (days || 30) * 86400000;
  const runs = cronRuns(p, 60000, fromMs, tz, fromMs + span);
  const heat = [0, 1, 2, 3, 4, 5, 6].map(() => new Array(24).fill(0));
  let minGap = null, maxGap = null;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].ms - fromMs <= 28 * 86400000) heat[runs[i].wall.getUTCDay()][runs[i].wall.getUTCHours()]++;
    if (i) {
      const g = runs[i].ms - runs[i - 1].ms;
      if (minGap == null || g < minGap) minGap = g;
      if (maxGap == null || g > maxGap) maxGap = g;
    }
  }
  return { runs: runs.length, perDay: runs.length / (days || 30), minGap, maxGap, heat, capped: runs.length >= 60000 };
}

/* "in 12m" / "in 3h" / "in 2d" — compact, English; the page localizes. */
export function cronRelative(date, nowMs) {
  const diff = (+date - (nowMs == null ? Date.now() : nowMs)) / 1000;
  if (diff < 60) return 'in ' + Math.round(diff) + 's';
  if (diff < 3600) return 'in ' + Math.round(diff / 60) + 'm';
  if (diff < 86400) return 'in ' + Math.round(diff / 3600) + 'h';
  return 'in ' + Math.round(diff / 86400) + 'd';
}
