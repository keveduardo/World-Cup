/**
 * 2026 World Cup Proxy — Cloudflare Worker
 * Replaces the Google Apps Script proxy. Faster (edge runtime) and free.
 *
 * Endpoints:
 *   ?type=matches              football-data fixtures + results
 *   ?type=standings            football-data group standings
 *   ?type=espn                 ESPN live scoreboard (scores + clock)
 *   ?type=espnsummary&event=ID ESPN match summary (goals, cards, stats, lineups)
 *   ?type=weather&lat=..&lon=..  Open-Meteo forecast + current (edge-cached 15m)
 *   ?type=favsave&code=X&teams=A|B&tz=America/Denver   save favorites
 *   ?type=favload&code=X       load favorites
 *
 *   --- Prediction pool (knockout) ---
 *   ?type=poolload&pool=CODE&me=PCODE     validate pool code + return my entry
 *   ?type=poolsave&pool=CODE&me=PCODE&name=...&picks=73:Brazil|90:...&champion=...&tiebreak=3
 *   ?type=poolboard&pool=CODE             redacted leaderboard data (locked picks only)
 *   ?type=poolsetchamp&admin=X&name=David&champion=France   admin override (bypasses champ lock)
 *
 * Requires one KV namespace binding named WC_KV (caching + favorites + pool).
 * Set FOOTBALL_API_KEY as a secret/variable.
 * Pool join codes: each code is a SEPARATE pool with its own leaderboard. A player
 *   belongs to whichever code they signed up with (stored as `pool` on their entry;
 *   legacy entries with no `pool` belong to 'bubblers'). Valid codes default to
 *   'bubblers,family'; override the set with a comma-separated POOL_CODES variable
 *   (or POOL_CODE for just the primary) without editing this file.
 */

const BASE_URL = 'https://api.football-data.org/v4';
const ESPN_SB  = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const ESPN_SUM = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=';

// Same-origin isn't enough here: the site (copa.brisaloca.com) calls this Worker on
// a different host, so it needs CORS. Reflect an allow-listed Origin instead of a
// blanket '*', so other websites can't read a victim's pool data from their browser.
// (CORS doesn't stop server-side curl — the code-as-login is the real guard — but it
// removes the cross-site browser vector.) Unknown/absent origins fall back to the
// production site; localhost + the worker's own *.workers.dev stay allowed for dev.
const ALLOWED_ORIGINS = ['https://copa.brisaloca.com'];
function corsHeaders(request) {
  const origin = (request && request.headers.get('Origin')) || '';
  let allow = ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(origin) ||
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https:\/\/[a-z0-9-]+\.workers\.dev$/.test(origin)) {
    allow = origin;
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    // Defense-in-depth on the API responses. (The copa.brisaloca.com *page* is
    // served by GitHub Pages, so its headers are set by a Cloudflare Transform
    // Rule at the zone level, not here.)
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

// ─── KNOCKOUT KICKOFF SCHEDULE (match number → [date, ET]) ───────────────────
// Mirrors KO_SCHEDULE in index.html. Summer ET = EDT = UTC-4, so kickoff in UTC
// is the listed hour + 4. Used to enforce per-match pick locks server-side.
const KO_TIMES = {
  73:['2026-06-28','15:00'], 76:['2026-06-29','13:00'], 74:['2026-06-29','16:30'],
  75:['2026-06-29','21:00'], 78:['2026-06-30','13:00'], 77:['2026-06-30','17:00'],
  79:['2026-06-30','22:00'], 80:['2026-07-01','12:00'], 82:['2026-07-01','16:00'],  // 79 moved +1h from 21:00 (mirror KO_SCHEDULE)
  81:['2026-07-01','20:00'], 84:['2026-07-02','15:00'], 83:['2026-07-02','19:00'],
  85:['2026-07-02','23:00'], 88:['2026-07-03','14:00'], 86:['2026-07-03','18:00'],
  87:['2026-07-03','21:30'], 90:['2026-07-04','13:00'], 89:['2026-07-04','17:00'],
  91:['2026-07-05','16:00'], 92:['2026-07-05','21:00'], 93:['2026-07-06','15:00'],
  94:['2026-07-06','20:00'], 95:['2026-07-07','12:00'], 96:['2026-07-07','16:00'],
  97:['2026-07-09','16:00'], 98:['2026-07-10','15:00'], 99:['2026-07-11','17:00'],
  100:['2026-07-11','21:00'],101:['2026-07-14','15:00'],102:['2026-07-15','15:00'],
  103:['2026-07-18','17:00'],104:['2026-07-19','15:00'],
};
function koKickoffMs(n) {
  const t = KO_TIMES[n];
  if (!t) return Infinity;
  const [y, mo, d] = t[0].split('-').map(Number);
  const [h, mi]    = t[1].split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h + 4, mi); // EDT (UTC-4) → add 4 for UTC
}
// ─── LIVE-STATUS PICK LOCK ────────────────────────────────────────────────────
// Picks lock when the game is ACTUALLY live (clock started) or done — not merely
// when a hardcoded schedule says it should have started. This kills premature
// locks from provider kickoff drift and keeps a delayed game (weather, etc.)
// editable until it truly kicks off. A far time backstop covers a feed outage so a
// finished game can't stay editable if we're blind to its status.
// Whitelist the NOT-started statuses (a short, stable set) and treat everything
// else — IN_PLAY, PAUSED, EXTRA_TIME, PENALTY_SHOOTOUT, FINISHED, SUSPENDED,
// AWARDED, or any status the provider adds later — as started. Fails safe: an
// unrecognized status locks rather than leaving a live/finished game editable.
const KO_NOT_STARTED = new Set(['SCHEDULED', 'TIMED', 'POSTPONED', 'CANCELLED']);
const LOCK_BACKSTOP_MS = 2 * 3600 * 1000;   // feed-outage safety only (2h past sched)
function koStageOf(n) {
  n = +n;
  if (n >= 73 && n <= 88) return 'LAST_32';
  if (n >= 89 && n <= 96) return 'LAST_16';
  if (n >= 97 && n <= 100) return 'QUARTER_FINALS';
  if (n >= 101 && n <= 102) return 'SEMI_FINALS';
  if (n === 103) return 'THIRD_PLACE';
  if (n === 104) return 'FINAL';
  return '';
}
// Has slot n's game started per the live feed? Binds slot→fixture by nearest
// scheduled kickoff within a 3h window (KO games are spaced hours apart, so this is
// unambiguous even if a provider shifts a kickoff by an hour). Returns true/false
// when the feed has the fixture, or null when we can't tell (no feed / unbindable).
function slotStarted(n, matches) {
  if (!Array.isArray(matches)) return null;
  const stage = koStageOf(n), target = koKickoffMs(n);
  if (!stage || !isFinite(target)) return null;
  let best = null, bestDiff = Infinity;
  for (const m of matches) {
    if (m.stage !== stage) continue;
    const t = m.utcDate ? Date.parse(m.utcDate) : NaN;
    if (!isFinite(t)) continue;
    const d = Math.abs(t - target);
    if (d < bestDiff) { bestDiff = d; best = m; }
  }
  if (!best || bestDiff > 3 * 3600 * 1000) return null;   // no confident binding
  return !KO_NOT_STARTED.has(best.status);
}
// Authoritative per-slot lock. Live/finished per the feed → locked; feed says
// pre-kickoff → editable (delays stay open); feed blind → 2h backstop past sched.
function lockedFor(n, matches, now) {
  const s = slotStarted(n, matches);
  if (s === true) return true;
  if (s === false) return false;
  return now >= koKickoffMs(n) + LOCK_BACKSTOP_MS;
}
// Champion/tiebreak lock: champion locks once the first game of the pool's start
// round has actually started (R32 for most, R16 for familia).
function champLockedLive(pool, matches, now) {
  const familia = String(pool || '').toLowerCase() === 'familia';
  const lo = familia ? 89 : 73, hi = familia ? 96 : 88;
  for (let n = lo; n <= hi; n++) if (KO_TIMES[n] && lockedFor(n, matches, now)) return true;
  return false;
}
async function loadMatchesSafe(env) {
  try {
    const d = await edgeCachedFetch('wc2026_matches',
      BASE_URL + '/competitions/WC/matches?season=2026', 600,
      { 'X-Auth-Token': env.FOOTBALL_API_KEY });
    return (d && Array.isArray(d.matches)) ? d.matches : null;
  } catch (e) { return null; }
}
// The 'familia' pool joins late and only scores from the Round of 16 (match 89) on.
// Every other pool (bubblers, family, legacy) plays the full bracket from the
// Round of 32 (match 73). This is the authoritative gate: picks below a pool's
// minimum slot are never saved, never revealed, and therefore never scored.
function minMatchFor(pool) {
  return String(pool || '').toLowerCase() === 'familia' ? 89 : 73;
}
function parsePicks(str) {
  const out = {};
  (str || '').split('|').filter(Boolean).forEach(p => {
    const i = p.indexOf(':');
    if (i > 0) {
      const n = p.slice(0, i);
      const name = p.slice(i + 1, i + 41);   // cap team name length (KV-bloat guard)
      if (name && KO_TIMES[n]) out[n] = name;
    }
  });
  return out;
}
// KV.list() returns at most 1000 keys per call; page through the cursor so a pool
// that ever exceeds 1000 members still enumerates fully.
async function listAllKeys(kv, prefix) {
  let keys = [], cursor;
  do {
    const r = await kv.list({ prefix, cursor });
    keys = keys.concat(r.keys);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return keys;
}
// Stable, non-secret per-player id used by the client to recognize ITS OWN row and
// key momentum. NOT derived from the personal code (that would be a brute-forceable
// oracle) — it's random, minted once and stored on the entry.
function newPlayerId() {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 12); }
  catch { return Math.random().toString(36).slice(2, 14); }
}

export default {
  async fetch(request, env) {
    const CORS = corsHeaders(request);
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    let status = 200;   // upstream/data failures return 502 so the client can tell
    const type = url.searchParams.get('type') || 'matches';
    const POOL_CODE = (env.POOL_CODE || 'bubblers');
    // Each join code is its own separate pool with its own leaderboard. A player
    // belongs to whichever code they signed up with (stored on their entry).
    // Legacy entries have no `pool` field → they belong to POOL_CODE ('bubblers').
    // Override the full set with a comma-separated POOL_CODES var if needed.
    const POOL_CODES = String(env.POOL_CODES || (POOL_CODE + ',family,familia'))
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const normPool  = (c) => String(c || '').trim().toLowerCase();
    const validPool = (c) => POOL_CODES.includes(normPool(c));
    const poolOf    = (e) => normPool((e && e.pool) || POOL_CODE);  // legacy → bubblers
    // Pool admin (remove members). Set as a Worker SECRET: `wrangler secret put
    // POOL_ADMIN_CODE`. Never put it in this repo or index.html. If unset, all
    // admin features are disabled (fail closed).
    const ADMIN_CODE = (env.POOL_ADMIN_CODE || '');
    const adminParam = (url.searchParams.get('admin') || '').trim();
    const isAdmin = !!ADMIN_CODE && adminParam === ADMIN_CODE;
    let payload;

    try {
      if (type === 'favsave') {
        const code  = (url.searchParams.get('code')  || '').trim().slice(0, 64);
        const teams = (url.searchParams.get('teams') || '');
        const tz    = (url.searchParams.get('tz')    || '');
        if (code) {
          // Cap the stored shape so a malformed/oversized request can't bloat KV.
          await env.WC_KV.put('fav_' + code, JSON.stringify({
            teams: teams.split('|').filter(Boolean).slice(0, 64).map(s => s.slice(0, 40)),
            tz: (typeof tz === 'string' && tz.length <= 64) ? tz : '',
          }));
          payload = { ok: true };
        } else {
          payload = { error: 'missing code' };
        }

      } else if (type === 'favload') {
        const code = (url.searchParams.get('code') || '').trim().slice(0, 64);
        const raw = code ? await env.WC_KV.get('fav_' + code) : null;
        if (!raw) {
          payload = { teams: [], tz: '' };
        } else {
          try { payload = JSON.parse(raw); }
          catch { payload = { teams: raw.split('|').filter(Boolean), tz: '' }; }
        }

      // ─── PREDICTION POOL ────────────────────────────────────────────────
      } else if (type === 'poolload') {
        // Returning members log in with just their personal code.
        const me = (url.searchParams.get('me') || '').trim().slice(0, 64);
        let entry = null;
        if (me) {
          const raw = await env.WC_KV.get('pool_player_' + me);
          if (raw) { try { entry = JSON.parse(raw); } catch {} }
        }
        if (entry) entry.pool = poolOf(entry);   // normalize (legacy → bubblers)
        // Expose the player's own stable id so the client can recognize its own
        // leaderboard row even if two members share a display name.
        payload = { ok: true, now: Date.now(),
                    id: (entry && entry.id) || null, entry };

      } else if (type === 'poolsave') {
        const pool = (url.searchParams.get('pool') || '').trim();
        const me   = (url.searchParams.get('me')   || '').trim().slice(0, 64);
        const name = (url.searchParams.get('name') || '').trim().slice(0, 40);
        if (!me) {
          payload = { error: 'missing personal code' };
        } else {
          const now      = Date.now();
          const matches  = await loadMatchesSafe(env);   // live status for the lock
          const incoming = parsePicks(url.searchParams.get('picks') || '');
          const champIn  = (url.searchParams.get('champion') || '').trim();
          const avatarRaw = url.searchParams.get('avatar');

          // Read-modify-write: two devices saving the same code near-simultaneously
          // are last-write-wins, and KV reads can be briefly stale across colos. We
          // accept this (a personal code is effectively one user); locked picks are
          // merged defensively below so the one value that must never regress can't.
          let cur = { name: '', picks: {}, champion: '' };
          let existed = false;
          const raw = await env.WC_KV.get('pool_player_' + me);
          if (raw) { try { cur = Object.assign(cur, JSON.parse(raw)); existed = true; } catch {} }

          // Creating a NEW entry requires a valid join code; that code becomes the
          // player's pool. Existing members (entry already exists) save with just
          // their personal code and keep whatever pool they joined with.
          if (!existed && !validPool(pool)) {
            payload = { error: 'bad pool code' };
          } else {
            // Stamp the pool: new entries take the join code; legacy/existing
            // entries without a pool default to POOL_CODE ('bubblers').
            cur.pool = existed ? poolOf(cur) : normPool(pool);
            cur.picks = cur.picks || {};
            if (!cur.id) cur.id = newPlayerId();   // stable id, minted once
            const minMatch = minMatchFor(cur.pool);
            // Self-heal: strip any stored picks below this pool's start round. A
            // stale client (before the R16 gate shipped) let 'familia' members pick
            // R32 matches (73-88); those must never score. Removing them here means
            // any save cleans the entry.
            for (const n of Object.keys(cur.picks)) {
              if (+n < minMatch) delete cur.picks[n];
            }
            const rejected = [];   // picks the client tried to change after kickoff

            // Explicit per-match clears ONLY. The client sends `&clear=89,92` when a
            // downstream pick became impossible (upstream changed / real result in).
            // ABSENCE OF A PICK IS NEVER A DELETE — a partial/empty payload (a save
            // fired before the client hydrated its picks from the server) can no
            // longer destroy stored picks. This is the data-loss fix. Locked picks
            // stay immune. Process clears BEFORE incoming so a re-pick in the same
            // request wins over its own clear.
            for (const n of (url.searchParams.get('clear') || '').split(',')) {
              if (KO_TIMES[n] && !lockedFor(+n, matches, now)) delete cur.picks[n];
            }
            // Apply incoming picks ONLY for matches that aren't live yet. A match
            // locks when its game actually kicks off (feed says live/finished), not
            // at a scheduled time — so a delayed game stays editable. Locked matches
            // keep what was stored; we report any attempted change so the client
            // doesn't flash a false "Saved ✓".
            for (const n of Object.keys(incoming)) {
              if (+n < minMatch) continue;   // out-of-range for this pool's start round
              if (!lockedFor(+n, matches, now)) cur.picks[n] = incoming[n];
              else if (cur.picks[n] !== incoming[n]) rejected.push(n);
            }
            // Champion is editable until this pool's champion lock (R32 kickoff, or
            // R16 kickoff for the late-starting 'familia' pool). Sending an EMPTY
            // champion clears it (mirrors the tiebreak pattern) — but only pre-lock.
            if (url.searchParams.has('champion') && !champLockedLive(cur.pool, matches, now)) {
              cur.champion = champIn.slice(0, 40);
            }
            // Tiebreaker (predicted total goals in the Final) — editable until the
            // Final kicks off. Empty string clears it.
            if (url.searchParams.has('tiebreak') && !lockedFor(104, matches, now)) {
              const tbIn = (url.searchParams.get('tiebreak') || '').trim();
              if (tbIn === '') { delete cur.tiebreak; }
              else { const v = parseInt(tbIn, 10); if (Number.isFinite(v) && v >= 0 && v <= 20) cur.tiebreak = v; }
            }
            if (name) cur.name = name;
            // Avatar cosmetics (not secret; small JSON of option indices). Require a
            // NON-EMPTY object: a pre-hydration client sends avatar={} (poolAvatar
            // null), which must not overwrite a real saved avatar with a blank one.
            if (avatarRaw && avatarRaw.length < 800) {
              try { const av = JSON.parse(avatarRaw); if (av && typeof av === 'object' && !Array.isArray(av) && Object.keys(av).length) cur.avatar = av; } catch (e) {}
            }
            cur.updatedAt = now;

            await env.WC_KV.put('pool_player_' + me, JSON.stringify(cur));
            payload = { ok: true, id: cur.id };
            if (rejected.length) payload.rejected = rejected;
          }
        }

      } else if (type === 'poolboard') {
        const pool = (url.searchParams.get('pool') || '').trim();
        const me   = (url.searchParams.get('me')   || '').trim().slice(0, 64);
        // Which pool's board to show: a valid join code names its pool; otherwise
        // a logged-in member sees their OWN pool. Each pool is fully separate.
        let boardPool = validPool(pool) ? normPool(pool) : null;
        if (!boardPool && me) {
          const meRaw = await env.WC_KV.get('pool_player_' + me);
          if (meRaw) { try { boardPool = poolOf(JSON.parse(meRaw)); } catch {} }
        }
        if (!boardPool) {
          payload = { error: 'not authorized' };
        } else {
          const now       = Date.now();
          const matches   = await loadMatchesSafe(env);   // live status for reveal
          const minMatch  = minMatchFor(boardPool);
          // Loop-invariant reveal gates (same for every player this render).
          const champRevealed = champLockedLive(boardPool, matches, now);
          const tbRevealed    = lockedFor(104, matches, now);
          const keys      = await listAllKeys(env.WC_KV, 'pool_player_');
          // Read every entry in parallel — this board is polled every ~30s by every
          // viewer during live games, so serial round-trips added real latency.
          const raws      = await Promise.all(keys.map(k => env.WC_KV.get(k.name)));
          const players   = [];
          for (let ki = 0; ki < keys.length; ki++) {
            const k = keys[ki], raw = raws[ki];
            if (!raw) continue;
            let e;
            try { e = JSON.parse(raw); } catch { continue; }
            if (poolOf(e) !== boardPool) continue;   // only this pool's members
            // Redact: only reveal a pick once that match is actually live (locked),
            // so nobody can copy a still-editable pick.
            const revealed = {};
            const picks = e.picks || {};
            for (const n of Object.keys(picks)) {
              if (+n < minMatch) continue;   // before this pool's start round → never scored
              if (lockedFor(+n, matches, now)) revealed[n] = picks[n];
            }
            const row = {
              name: e.name || 'Anon',
              id: e.id || null,          // stable, non-secret self-identification
              picks: revealed,
              champion: champRevealed ? (e.champion || '') : '',
              // Tiebreaker stays hidden (like picks) until the Final is live.
              tiebreak: tbRevealed ? (e.tiebreak ?? null) : null,
              avatar: e.avatar || null,
              updatedAt: e.updatedAt || 0,
            };
            // Personal codes are private; only an authenticated admin sees them
            // (needed to target a removal).
            if (isAdmin) row.code = k.name.replace('pool_player_', '');
            players.push(row);
          }
          payload = { ok: true, now, players, admin: isAdmin, pool: boardPool };
        }

      } else if (type === 'pooldelete') {
        // Admin-only: remove a member's entry. Auth enforced server-side against
        // the POOL_ADMIN_CODE secret — a client flag alone can't delete anything.
        const target = (url.searchParams.get('target') || '').trim().slice(0, 64);
        if (!isAdmin) {
          payload = { error: 'not authorized' };
        } else if (!target) {
          payload = { error: 'missing target' };
        } else {
          await env.WC_KV.delete('pool_player_' + target);
          payload = { ok: true, deleted: target };
        }

      } else if (type === 'poolsetchamp') {
        // Admin-only: set/override a member's champion, DELIBERATELY bypassing the
        // normal champion lock (for commissioner fixes — e.g. members who never got
        // to pick). Target by personal code, or by name within a pool. Auth enforced
        // server-side against POOL_ADMIN_CODE.
        const target = (url.searchParams.get('target') || '').trim().slice(0, 64);      // personal code
        const name   = (url.searchParams.get('name')   || '').trim();      // or display name
        const champ  = (url.searchParams.get('champion') || '').trim().slice(0, 40);
        const pool   = (url.searchParams.get('pool') || '').trim();
        if (!isAdmin) {
          payload = { error: 'not authorized' };
        } else if (!target && !name) {
          payload = { error: 'missing target (code) or name' };
        } else {
          let key = null, entry = null;
          if (target) {
            key = 'pool_player_' + target;
            const raw = await env.WC_KV.get(key);
            if (raw) { try { entry = JSON.parse(raw); } catch {} } else { key = null; }
          } else {
            // Find the unique member with this name in the given pool (default: primary).
            const boardPool = validPool(pool) ? normPool(pool) : POOL_CODE;
            const keys = await listAllKeys(env.WC_KV, 'pool_player_');
            const raws = await Promise.all(keys.map(k => env.WC_KV.get(k.name)));
            const hits = [];
            for (let ki = 0; ki < keys.length; ki++) {
              const raw = raws[ki]; if (!raw) continue;
              let e; try { e = JSON.parse(raw); } catch { continue; }
              if (poolOf(e) !== boardPool) continue;
              if ((e.name || '').trim().toLowerCase() === name.toLowerCase()) hits.push({ k: keys[ki].name, e });
            }
            if (hits.length === 1) { key = hits[0].k; entry = hits[0].e; }
            else if (hits.length > 1) payload = { error: `multiple members named "${name}" — target by code instead` };
            else payload = { error: `no member named "${name}" in pool "${boardPool}"` };
          }
          if (!payload) {
            if (!key || !entry) {
              payload = { error: 'member not found' };
            } else {
              entry.champion = champ;            // set, or clear when champion is empty
              entry.updatedAt = Date.now();
              await env.WC_KV.put(key, JSON.stringify(entry));
              payload = { ok: true, name: entry.name || '', champion: champ };
            }
          }
        }

      } else if (type === 'espnsummary') {
        const eid = (url.searchParams.get('event') || '').replace(/[^0-9]/g, '');
        if (eid) {
          payload = await edgeCachedFetch('wc_sum_' + eid, ESPN_SUM + eid, 30, null);
        } else {
          payload = { error: 'missing event id' };
        }

      } else if (type === 'weather') {
        // Proxy Open-Meteo so the browser only talks to this Worker (no third-party
        // request). Coords are validated + rounded; the upstream params are fixed
        // here, so this can only ever return a weather forecast (not an open proxy).
        const lat = parseFloat(url.searchParams.get('lat'));
        const lon = parseFloat(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
            lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          payload = { error: 'bad coordinates' };
        } else {
          const la = lat.toFixed(4), lo = lon.toFixed(4);
          const omUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + la + '&longitude=' + lo
            + '&current=temperature_2m,weather_code,is_day'
            + '&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit'
            + '&timezone=auto&forecast_days=16';
          payload = await edgeCachedFetch('wc_wx_' + la + '_' + lo, omUrl, 900, null);
        }

      } else if (type === 'espn') {
        payload = await edgeCachedFetch('wc2026_espn', ESPN_SB, 30, null);

      } else if (type === 'standings') {
        payload = await edgeCachedFetch('wc2026_standings',
          BASE_URL + '/competitions/WC/standings?season=2026', 600,
          { 'X-Auth-Token': env.FOOTBALL_API_KEY });

      } else {
        payload = await edgeCachedFetch('wc2026_matches',
          BASE_URL + '/competitions/WC/matches?season=2026', 600,
          { 'X-Auth-Token': env.FOOTBALL_API_KEY });
      }
    } catch (err) {
      // Log server-side (visible via `wrangler tail`) but never echo internals to
      // the client — raw errors leaked KV limits / implementation details. Return a
      // real 5xx so the client can tell a fetch failed (and not blank its cached data).
      console.error('worker error:', err);
      payload = { error: 'request failed' };
      status = 502;
    }

    return new Response(JSON.stringify(payload), { status, headers: CORS });
  },
};

/**
 * Fetch with Cloudflare's edge Cache API, which supports sub-60s TTLs.
 * Used for ESPN live data so scores stay fresh (~30s) during matches.
 */
async function edgeCachedFetch(cacheKey, url, ttl, headers) {
  const cache = caches.default;
  const cacheUrl = new Request('https://cache.local/' + cacheKey);

  let hit = await cache.match(cacheUrl);
  if (hit) return hit.json();

  const resp = await fetch(url, headers ? { headers } : {});
  // Never cache an upstream failure: a football-data 429/5xx body would otherwise be
  // served for the full TTL (and each colo caches independently). Throw so the caller
  // returns a 502 instead of poisoning the cache with an error payload.
  if (!resp.ok) throw new Error('upstream ' + resp.status + ' for ' + cacheKey);
  const data = await resp.json();

  const toCache = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl },
  });
  try { await cache.put(cacheUrl, toCache.clone()); } catch (e) {}

  return data;
}
