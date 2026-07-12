# World Cup Schedule

Multi-source match data folded into one canonical schedule — this is the
data-plane core of the [World Cup tab on subnsub.com](https://subnsub.com),
published so the normalisation, standings parsing and time-zone bucketing
behind the tab are auditable.

## Files

- [`worldcup-schedule.js`](worldcup-schedule.js) — the module: upstream
  normalisers, the match status machine, kickoff time-zone bucketing,
  featured-match pick
- [`demo.html`](demo.html) — minimal standalone page exercising the module
  on built-in sample payloads

## Usage

```js
import {
  normalizeEspnScoreboard, parseEspnStandings, normalizeTsdbSeason,
  utcTodayWindow, trimToWindow, sortSchedule,
  groupMatchesByDay, pickFeatured, inTodayWindow,
  BADGE, hasScore, isLive, isUpcoming, advances, compLabel,
  fmtDate, fmtTime,
} from './worldcup-schedule.js';

// Server side of the site's proxy: fold either upstream into the canonical shape.
const { standings, groupOf } = parseEspnStandings(espnStandingsPayload);
let matches = normalizeEspnScoreboard(espnScoreboardPayload, groupOf)
           || normalizeTsdbSeason(tsdbSeasonPayload);          // fallback source
const win = utcTodayWindow();                                  // yesterday..tomorrow, UTC
matches = sortSchedule(trimToWindow(matches, win.days));

// Client side: bucket and label in the viewer's chosen zone.
const days = groupMatchesByDay(matches, 'Asia/Tokyo');
const hero = pickFeatured(matches, allMatches, 'Asia/Tokyo');
const label = hasScore(hero.status)
  ? `${hero.homeTeam.score} : ${hero.awayTeam.score} (${BADGE[hero.status] || ''})`
  : fmtTime(hero.utcDate, { locale: 'en', timeZone: 'Asia/Tokyo' });
```

## Canonical match shape

```
{ id, utcDate, status, matchday, group, stage, venue,
  homeTeam: { name, short, crest, code, score }, awayTeam: {…} }
```

- `status` ∈ `SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED | POSTPONED |
  CANCELLED | SUSPENDED` (`TIMED` is a legacy alias kept for old payloads).
- `code` is the FIFA three-letter code; knockout placeholders (`1A`, `W49`)
  pass through unmapped.
- `score` is `null` until `hasScore(status)` — upstreams report `"0"` for
  unplayed fixtures, which must keep showing kickoff time instead of a
  phantom 0-0.

## Site API contract

On subnsub.com the tab only talks to the same-origin `/api/worldcup` proxy,
which calls the upstreams server-side and returns already-normalised data:

- `?view=standings` → `{ ok, standings: [{ group, table: [row…] }] }` with
  rows `{ pos, team, short, crest, code, played, won, draw, lost, gf, ga,
  gd, pts }` (this module's `parseEspnStandings` output)
- `?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD` → `{ ok, matches }` for the
  yesterday..tomorrow UTC window
- bare request → `{ ok, matches }` for the full tournament
- failures → `{ ok: false, error }` (`upstream_error`, `rate_limited`)

Upstreams are public, key-free JSON feeds: ESPN's scoreboard + standings
(primary; its `?dates=` buckets are US-Eastern days, hence
`utcTodayWindow()`'s over-fetch-one-day-and-trim shape) and TheSportsDB's
season list (match fallback only — its free tier truncates the season and
its standings lag, so standings have no fallback; partial data beats a dead
widget). Responses are edge-cached ~90 s; the tab refreshes each view on a
2-minute stale-while-revalidate tick and back-dates a failed fetch to retry
in ~20 s instead of hammering a failing upstream every beat.

## Boundaries

- No fetching, storage or DOM here — every function eats an already-fetched
  payload object; time-zone answers come from `Intl` with the caller's zone.
- On-site extras deliberately not extracted: flag rendering, localized
  team/venue names, the broadcaster table, and the team-profile modal with
  its static 1930–2022 history dataset (`WC_HIST`) — that dataset is
  content, not logic, and stays with the site.
