/* World Cup 2026 schedule — core logic of the World Cup tab on
   subnsub.com, kept in lockstep with the in-page version and the
   same-origin /api/worldcup proxy it renders from.

   Everything downstream consumes ONE canonical match shape, whichever
   upstream produced it:

     { id, utcDate, status, matchday, group, stage, venue,
       homeTeam: { name, short, crest, code, score },
       awayTeam: { name, short, crest, code, score } }

   status ∈ SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED |
            POSTPONED | CANCELLED | SUSPENDED
   code   = FIFA three-letter code (BRA, GER, …); knockout placeholders
            ("1A", "W49") pass through as-is and simply don't map.
   score  = null until the status machine says the fixture has one —
            upstreams report "0" for unplayed games, and a fixture must
            keep showing its kickoff time instead of a phantom 0-0.

   This module owns the data plane around that shape: the normalisers
   for the two upstream payloads the proxy consumes (ESPN scoreboard +
   standings as primary, TheSportsDB season list as fallback), the match
   status machine, and the kickoff time-zone bucketing the schedule
   views are built from. Nothing here fetches, stores or touches the
   DOM: every function eats an already-fetched payload object (see the
   README for the proxy contract). */

/* ── status machine ──────────────────────────────────────────────────
   TIMED is a legacy alias for SCHEDULED (an earlier backend emitted it);
   it is kept so older cached payloads still classify as upcoming. */

export const BADGE = {
  IN_PLAY: 'LIVE', PAUSED: 'HT', FINISHED: 'FT',
  POSTPONED: 'PPD', CANCELLED: 'CANC', SUSPENDED: 'SUSP',
};

/* A fixture "has a score" once play started — including suspended games,
   which keep the score they were stopped at. The client renders kickoff
   time for everything else. */
export const hasScore = st =>
  st === 'IN_PLAY' || st === 'PAUSED' || st === 'FINISHED' || st === 'SUSPENDED';

export function isLive(m){ return m.status === 'IN_PLAY' || m.status === 'PAUSED'; }
export function isUpcoming(m){ return m.status === 'SCHEDULED' || m.status === 'TIMED'; }
export function byKick(a, b){ return new Date(a.utcDate) - new Date(b.utcDate); }

/* Top two of each group advance in the 2026 48-team format. */
export function advances(row){ return row.pos != null && row.pos <= 2; }

/* Group/stage labels arrive as English text ("Group A", "GROUP_A",
   "Round of 32"); the group forms are normalised here, unrecognised
   strings pass through untouched. On-site both go through i18n. */
export function groupLabel(g){
  const m = /^(?:GROUP[_ ]|Group )([A-L])$/i.exec(g || '');
  return m ? 'Group ' + m[1].toUpperCase() : (g || '');
}
export function compLabel(m){
  return m.group ? groupLabel(m.group) : (m.stage || '');
}

/* ── ESPN normalisation (primary source) ─────────────────────────────
   Scoreboard payload: site.api.espn.com …/fifa.world/scoreboard. */

function espnStatus(type){
  const name = (type && type.name) || '';
  if (name === 'STATUS_HALFTIME')  return 'PAUSED';
  if (name === 'STATUS_POSTPONED') return 'POSTPONED';
  if (name === 'STATUS_CANCELED')  return 'CANCELLED';
  if (name === 'STATUS_SUSPENDED' || name === 'STATUS_ABANDONED') return 'SUSPENDED';
  const state = (type && type.state) || 'pre';
  if (state === 'in')   return 'IN_PLAY';
  if (state === 'post') return 'FINISHED';
  return 'SCHEDULED';
}

/* ESPN reports score "0" for unplayed fixtures; null it out pre-kickoff
   so consumers keep showing kickoff time. */
function espnTeam(c, scored){
  const t = (c && c.team) || {};
  const n = scored && c && c.score != null ? parseInt(c.score, 10) : NaN;
  return {
    name:  t.displayName || t.name || '?',
    short: t.abbreviation || '',
    crest: '',
    code:  t.abbreviation || '',  // FIFA code (CAN, MEX…)
    score: Number.isFinite(n) ? n : null,
  };
}

export function normalizeEspnEvent(ev, groupOf){
  groupOf = groupOf || {};
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const cs = comp.competitors || [];
  const home = cs.find(c => c.homeAway === 'home') || cs[0] || null;
  const away = cs.find(c => c.homeAway === 'away') || cs[1] || null;
  const st = espnStatus(ev.status && ev.status.type);
  const scored = hasScore(st);
  const slug = (ev.season && ev.season.slug) || '';   // "group-stage", "final"
  const stage = slug
    ? slug.split('-').map(w => w === 'of' ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : null;
  const venue = comp.venue && comp.venue.fullName
    ? comp.venue.fullName + (comp.venue.address && comp.venue.address.city ? ', ' + comp.venue.address.city : '')
    : null;
  const teamId = c => (c && c.team && c.team.id) || '';
  return {
    id:       ev.id,
    utcDate:  ev.date || null,
    status:   st,
    matchday: null,  // ESPN carries no round number; the tab doesn't read it
    /* Group label only for group-stage fixtures: groupOf is keyed by team id,
       and once a knockout tie has real teams it would otherwise resolve to the
       team's first-round group and shadow the stage label downstream. */
    group:    slug === 'group-stage'
                ? groupOf[teamId(home)] || groupOf[teamId(away)] || null
                : null,
    stage,
    venue,
    homeTeam: espnTeam(home, scored),
    awayTeam: espnTeam(away, scored),
  };
}

export function normalizeEspnScoreboard(data, groupOf){
  const events = data && Array.isArray(data.events) ? data.events : null;
  if (!events) return null;
  return events.map(ev => normalizeEspnEvent(ev, groupOf));
}

/* One parse, two consumers: the standings view itself, and the team-id →
   "Group X" index the match normaliser stamps onto group-stage fixtures
   (the scoreboard payload has no group field of its own). ESPN's generic
   stat names (pointsFor/pointsAgainst/pointDifferential) are goals here. */
export function parseEspnStandings(data){
  const groups = [];
  const groupOf = {};
  for (const child of (data && data.children) || []) {
    const entries = (child.standings && child.standings.entries) || [];
    const table = entries.map(e => {
      const t = e.team || {};
      const stats = {};
      for (const s of e.stats || []) stats[s.name] = s.value;
      if (t.id) groupOf[t.id] = child.name || '';
      return {
        pos:    stats.rank || 0,
        team:   t.displayName || t.name || '?',
        short:  t.abbreviation || '',
        crest:  '',
        code:   t.abbreviation || '',
        played: stats.gamesPlayed || 0,
        won:    stats.wins || 0,
        draw:   stats.ties || 0,
        lost:   stats.losses || 0,
        gf:     stats.pointsFor || 0,
        ga:     stats.pointsAgainst || 0,
        gd:     stats.pointDifferential || 0,
        pts:    stats.points || 0,
      };
    }).sort((a, b) => a.pos - b.pos);
    groups.push({ group: child.name || 'Group', table });
  }
  groups.sort((a, b) => a.group.localeCompare(b.group));
  return { standings: groups, groupOf };
}

/* ── TheSportsDB normalisation (fallback source) ─────────────────────
   Season payload: thesportsdb.com …/eventsseason.php. Its rows carry
   team names, not codes, so names are mapped onto FIFA codes here: all
   48 entrants as ESPN spells them plus the variants TheSportsDB uses
   ("Czech Republic", "USA", "Turkey", "Curacao", …). */

export const NAME_TO_CODE = {
  'algeria': 'ALG', 'argentina': 'ARG', 'australia': 'AUS', 'austria': 'AUT',
  'belgium': 'BEL', 'bosnia-herzegovina': 'BIH', 'bosnia and herzegovina': 'BIH',
  'brazil': 'BRA', 'canada': 'CAN', 'cape verde': 'CPV', 'cape verde islands': 'CPV',
  'colombia': 'COL', 'congo dr': 'COD', 'dr congo': 'COD', 'croatia': 'CRO',
  'curaçao': 'CUW', 'curacao': 'CUW', 'czechia': 'CZE', 'czech republic': 'CZE',
  'ecuador': 'ECU', 'egypt': 'EGY', 'england': 'ENG', 'france': 'FRA',
  'germany': 'GER', 'ghana': 'GHA', 'haiti': 'HAI', 'iran': 'IRN', 'iraq': 'IRQ',
  'ivory coast': 'CIV', "côte d'ivoire": 'CIV', 'japan': 'JPN', 'jordan': 'JOR',
  'mexico': 'MEX', 'morocco': 'MAR', 'netherlands': 'NED', 'new zealand': 'NZL',
  'norway': 'NOR', 'panama': 'PAN', 'paraguay': 'PAR', 'portugal': 'POR',
  'qatar': 'QAT', 'saudi arabia': 'KSA', 'scotland': 'SCO', 'senegal': 'SEN',
  'south africa': 'RSA', 'south korea': 'KOR', 'korea republic': 'KOR',
  'spain': 'ESP', 'sweden': 'SWE', 'switzerland': 'SUI', 'tunisia': 'TUN',
  'türkiye': 'TUR', 'turkey': 'TUR', 'united states': 'USA', 'usa': 'USA',
  'uruguay': 'URU', 'uzbekistan': 'UZB',
};
export const codeFor = name => NAME_TO_CODE[(name || '').toLowerCase()] || '';

const TSDB_STATUS = {
  'NS': 'SCHEDULED', 'NOT STARTED': 'SCHEDULED',
  '1H': 'IN_PLAY', '2H': 'IN_PLAY', 'ET': 'IN_PLAY', 'BT': 'IN_PLAY',
  'P': 'IN_PLAY', 'LIVE': 'IN_PLAY',
  'HT': 'PAUSED',
  'FT': 'FINISHED', 'AET': 'FINISHED', 'PEN': 'FINISHED', 'AP': 'FINISHED',
  'MATCH FINISHED': 'FINISHED',
  'POSTPONED': 'POSTPONED', 'PST': 'POSTPONED',
  'CANCELLED': 'CANCELLED', 'CANCELED': 'CANCELLED',
  'ABANDONED': 'SUSPENDED', 'SUSPENDED': 'SUSPENDED',
};

function tsdbTeam(name, score, scored){
  const code = codeFor(name);
  const n = scored && score != null ? parseInt(score, 10) : NaN;
  return {
    name:  name || '?',
    short: code,
    crest: '',
    code,
    score: Number.isFinite(n) ? n : null,
  };
}

export function normalizeTsdbEvent(ev){
  const postponed = (ev.strPostponed || '').toLowerCase() === 'yes';
  const raw = (ev.strStatus || '').trim().toUpperCase();
  const st = postponed ? 'POSTPONED' : (TSDB_STATUS[raw] || 'SCHEDULED');
  const scored = hasScore(st);
  /* strTimestamp is UTC but lacks a zone suffix ("2026-06-11T19:00:00") —
     bare-parse would read it as device-local time in the browser. */
  let iso = ev.strTimestamp || null;
  if (!iso && ev.dateEvent) iso = ev.dateEvent + 'T' + (ev.strTime || '00:00:00');
  if (iso && !/(?:Z|[+-]\d\d:?\d\d)$/i.test(iso)) iso += 'Z';
  return {
    id:       ev.idEvent,
    utcDate:  iso,
    status:   st,
    matchday: parseInt(ev.intRound, 10) || null,
    group:    null,
    stage:    null,
    venue:    ev.strVenue || null,
    homeTeam: tsdbTeam(ev.strHomeTeam, ev.intHomeScore, scored),
    awayTeam: tsdbTeam(ev.strAwayTeam, ev.intAwayScore, scored),
  };
}

export function normalizeTsdbSeason(data){
  const events = data && Array.isArray(data.events) ? data.events : null;
  if (!events) return null;
  return events.map(normalizeTsdbEvent);
}

/* ── "today" UTC window ──────────────────────────────────────────────
   The today view is yesterday..tomorrow in UTC. ESPN buckets ?dates= by
   US-Eastern day, not UTC, so the fetch range starts one extra day back
   and the normalised list is trimmed to the UTC window afterwards (a
   UTC-early-morning kickoff lives in the previous Eastern day's bucket). */
export function utcTodayWindow(now){
  const day = (offset) => {
    const d = now ? new Date(now) : new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  return {
    days: new Set([day(-1), day(0), day(1)]),
    fetchRange: day(-2).replace(/-/g, '') + '-' + day(1).replace(/-/g, ''),
  };
}

export function trimToWindow(matches, days){
  return matches.filter(m => m.utcDate && days.has(m.utcDate.slice(0, 10)));
}

export function sortSchedule(matches){
  return matches.slice().sort((a, b) => (a.utcDate || '').localeCompare(b.utcDate || ''));
}

/* ── kickoff time-zone handling ──────────────────────────────────────
   The tab lets the viewer pick any IANA zone; every "which day is this?"
   question is answered in that zone (or the browser zone when unset).
   en-CA is used as a stable YYYY-MM-DD day-key locale. */

export function fmtDate(iso, opts){
  opts = opts || {};
  try {
    const d = new Date(iso);
    const o = { weekday: 'short', month: 'short', day: 'numeric' };
    if (opts.timeZone) o.timeZone = opts.timeZone;
    return d.toLocaleDateString(opts.locale, o);
  } catch (_) { return iso ? iso.slice(0, 10) : ''; }
}

export function fmtTime(iso, opts){
  opts = opts || {};
  try {
    const d = new Date(iso);
    const o = { hour: '2-digit', minute: '2-digit' };
    if (opts.timeZone) o.timeZone = opts.timeZone;
    return d.toLocaleTimeString(opts.locale, o);
  } catch (_) { return ''; }
}

export function dateInTZ(iso, timeZone){
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString('en-CA', timeZone ? { timeZone } : {}); }
  catch (_) { return iso.slice(0, 10); }
}

export function isToday(iso, timeZone){
  try { return dateInTZ(iso, timeZone) === dateInTZ(new Date().toISOString(), timeZone); }
  catch (_) { return false; }
}
export function isTomorrow(iso, timeZone){
  try {
    const t = new Date(); t.setDate(t.getDate() + 1);
    return dateInTZ(iso, timeZone) === dateInTZ(t.toISOString(), timeZone);
  } catch (_) { return false; }
}
export function isYesterday(iso, timeZone){
  try {
    const y = new Date(); y.setDate(y.getDate() - 1);
    return dateInTZ(iso, timeZone) === dateInTZ(y.toISOString(), timeZone);
  } catch (_) { return false; }
}
export function inTodayWindow(m, timeZone){
  return isYesterday(m.utcDate, timeZone) || isToday(m.utcDate, timeZone) || isTomorrow(m.utcDate, timeZone);
}

/* Bucket a match list into per-day groups in the viewer's zone, each
   group sorted by kickoff. Matches with no kickoff land under '?'. */
export function groupMatchesByDay(matches, timeZone){
  const byDate = {};
  matches.slice().sort(byKick).forEach(m => {
    const k = m.utcDate ? dateInTZ(m.utcDate, timeZone) : '?';
    (byDate[k] = byDate[k] || []).push(m);
  });
  return Object.keys(byDate).sort().map(k => ({ date: k, matches: byDate[k] }));
}

/* ── featured-match pick ─────────────────────────────────────────────
   The hero slot prefers, in order: a live match in the ±1-day window,
   the next upcoming one there, the most recent one there, then the next
   upcoming match of the whole schedule, then the last match played. */
export function pickFeatured(today, all, timeZone){
  const t = (today || []).filter(m => inTodayWindow(m, timeZone)).sort(byKick);
  const live = t.filter(isLive);
  if (live.length) return live[0];
  const up = t.filter(isUpcoming);
  if (up.length) return up[0];
  if (t.length) return t[t.length - 1];
  const a = (all || []).slice().sort(byKick);
  return a.filter(isUpcoming)[0] || a[a.length - 1] || null;
}
