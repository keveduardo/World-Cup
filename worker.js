/**
 * 2026 World Cup Proxy — Cloudflare Worker
 * Replaces the Google Apps Script proxy. Faster (edge runtime) and free.
 *
 * Endpoints:
 *   ?type=matches              football-data fixtures + results
 *   ?type=standings            football-data group standings
 *   ?type=espn                 ESPN live scoreboard (scores + clock)
 *   ?type=espnsummary&event=ID ESPN match summary (goals, cards, stats, lineups)
 *   ?type=favsave&code=X&teams=A|B&tz=America/Denver   save favorites
 *   ?type=favload&code=X       load favorites
 *
 *   --- Prediction pool (knockout) ---
 *   ?type=poolload&pool=CODE&me=PCODE     validate pool code + return my entry
 *   ?type=poolsave&pool=CODE&me=PCODE&name=...&picks=73:Brazil|90:...&champion=...
 *   ?type=poolboard&pool=CODE             redacted leaderboard data (locked picks only)
 *
 * Requires one KV namespace binding named WC_KV (caching + favorites + pool).
 * Set FOOTBALL_API_KEY as a secret/variable.
 * POOL_CODE is the shared code friends/family enter to join the pool. It defaults
 *   to 'bubblers' below; override it with a POOL_CODE variable to change it without
 *   editing this file.
 */

const BASE_URL = 'https://api.football-data.org/v4';
const ESPN_SB  = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const ESPN_SUM = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ─── KNOCKOUT KICKOFF SCHEDULE (match number → [date, ET]) ───────────────────
// Mirrors KO_SCHEDULE in index.html. Summer ET = EDT = UTC-4, so kickoff in UTC
// is the listed hour + 4. Used to enforce per-match pick locks server-side.
const KO_TIMES = {
  73:['2026-06-28','15:00'], 76:['2026-06-29','13:00'], 74:['2026-06-29','16:30'],
  75:['2026-06-29','21:00'], 78:['2026-06-30','13:00'], 77:['2026-06-30','17:00'],
  79:['2026-06-30','21:00'], 80:['2026-07-01','12:00'], 82:['2026-07-01','16:00'],
  81:['2026-07-01','20:00'], 84:['2026-07-02','15:00'], 83:['2026-07-02','19:00'],
  85:['2026-07-02','23:00'], 88:['2026-07-03','14:00'], 86:['2026-07-03','18:00'],
  87:['2026-07-03','21:30'], 90:['2026-07-04','13:00'], 89:['2026-07-04','17:00'],
  91:['2026-07-05','16:00'], 92:['2026-07-05','20:00'], 93:['2026-07-06','15:00'],
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
// Champion pick locks at the first Round-of-32 kickoff.
function championLockMs() {
  let min = Infinity;
  for (let n = 73; n <= 88; n++) if (KO_TIMES[n]) min = Math.min(min, koKickoffMs(n));
  return min;
}
function parsePicks(str) {
  const out = {};
  (str || '').split('|').filter(Boolean).forEach(p => {
    const i = p.indexOf(':');
    if (i > 0) {
      const n = p.slice(0, i);
      const name = p.slice(i + 1);
      if (name && KO_TIMES[n]) out[n] = name;
    }
  });
  return out;
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const type = url.searchParams.get('type') || 'matches';
    const POOL_CODE = (env.POOL_CODE || 'bubblers');
    let payload;

    try {
      if (type === 'favsave') {
        const code  = (url.searchParams.get('code')  || '').trim();
        const teams = (url.searchParams.get('teams') || '');
        const tz    = (url.searchParams.get('tz')    || '');
        if (code) {
          await env.WC_KV.put('fav_' + code, JSON.stringify({
            teams: teams.split('|').filter(Boolean),
            tz: tz,
          }));
          payload = { ok: true };
        } else {
          payload = { error: 'missing code' };
        }

      } else if (type === 'favload') {
        const code = (url.searchParams.get('code') || '').trim();
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
        const me = (url.searchParams.get('me') || '').trim();
        let entry = null;
        if (me) {
          const raw = await env.WC_KV.get('pool_player_' + me);
          if (raw) { try { entry = JSON.parse(raw); } catch {} }
        }
        payload = { ok: true, now: Date.now(), championLock: championLockMs(), entry };

      } else if (type === 'poolsave') {
        const pool = (url.searchParams.get('pool') || '').trim();
        const me   = (url.searchParams.get('me')   || '').trim();
        const name = (url.searchParams.get('name') || '').trim().slice(0, 40);
        if (!me) {
          payload = { error: 'missing personal code' };
        } else {
          const now      = Date.now();
          const incoming = parsePicks(url.searchParams.get('picks') || '');
          const champIn  = (url.searchParams.get('champion') || '').trim();
          const avatarRaw = url.searchParams.get('avatar');

          let cur = { name: '', picks: {}, champion: '' };
          let existed = false;
          const raw = await env.WC_KV.get('pool_player_' + me);
          if (raw) { try { cur = Object.assign(cur, JSON.parse(raw)); existed = true; } catch {} }

          // Creating a NEW entry requires the shared pool code. Existing members
          // (their entry already exists) can save with just their personal code.
          if (!existed && pool !== POOL_CODE) {
            payload = { error: 'bad pool code' };
          } else {
            cur.picks = cur.picks || {};

            // Apply incoming picks ONLY for matches that haven't kicked off yet.
            // Locked matches keep whatever was stored before kickoff.
            for (const n of Object.keys(incoming)) {
              if (now < koKickoffMs(+n)) cur.picks[n] = incoming[n];
            }
            // Let the client clear downstream picks: drop any unlocked stored pick
            // the client no longer sends. Locked picks are never removed.
            for (const n of Object.keys(cur.picks)) {
              if (now < koKickoffMs(+n) && !(n in incoming)) delete cur.picks[n];
            }
            // Champion is editable until the first R32 kickoff.
            if (champIn && now < championLockMs()) cur.champion = champIn.slice(0, 40);
            if (name) cur.name = name;
            // Avatar cosmetics (not secret; small JSON of option indices).
            if (avatarRaw && avatarRaw.length < 800) {
              try { const av = JSON.parse(avatarRaw); if (av && typeof av === 'object' && !Array.isArray(av)) cur.avatar = av; } catch (e) {}
            }
            cur.updatedAt = now;

            await env.WC_KV.put('pool_player_' + me, JSON.stringify(cur));
            payload = { ok: true };
          }
        }

      } else if (type === 'poolboard') {
        const pool = (url.searchParams.get('pool') || '').trim();
        const me   = (url.searchParams.get('me')   || '').trim();
        // Viewable by anyone with the pool code, or any existing member (by code).
        let allowed = (pool === POOL_CODE);
        if (!allowed && me) {
          const meRaw = await env.WC_KV.get('pool_player_' + me);
          if (meRaw) allowed = true;
        }
        if (!allowed) {
          payload = { error: 'not authorized' };
        } else {
          const now       = Date.now();
          const champLock = championLockMs();
          const list      = await env.WC_KV.list({ prefix: 'pool_player_' });
          const players   = [];
          for (const k of list.keys) {
            const raw = await env.WC_KV.get(k.name);
            if (!raw) continue;
            let e;
            try { e = JSON.parse(raw); } catch { continue; }
            // Redact: only reveal a pick once that match has kicked off, so
            // nobody can copy picks before lock.
            const revealed = {};
            const picks = e.picks || {};
            for (const n of Object.keys(picks)) {
              if (now >= koKickoffMs(+n)) revealed[n] = picks[n];
            }
            players.push({
              name: e.name || 'Anon',
              picks: revealed,
              champion: (now >= champLock) ? (e.champion || '') : '',
              avatar: e.avatar || null,
              updatedAt: e.updatedAt || 0,
            });
          }
          payload = { ok: true, now, championLock: champLock, players };
        }

      } else if (type === 'espnsummary') {
        const eid = (url.searchParams.get('event') || '').replace(/[^0-9]/g, '');
        if (eid) {
          payload = await edgeCachedFetch('wc_sum_' + eid, ESPN_SUM + eid, 30, null);
        } else {
          payload = { error: 'missing event id' };
        }

      } else if (type === 'espn') {
        payload = await edgeCachedFetch('wc2026_espn', ESPN_SB, 30, null);

      } else if (type === 'standings') {
        payload = await cachedFetch(env, 'wc2026_standings',
          BASE_URL + '/competitions/WC/standings?season=2026', 60,
          { 'X-Auth-Token': env.FOOTBALL_API_KEY });

      } else {
        payload = await cachedFetch(env, 'wc2026_matches',
          BASE_URL + '/competitions/WC/matches?season=2026', 60,
          { 'X-Auth-Token': env.FOOTBALL_API_KEY });
      }
    } catch (err) {
      payload = { error: String(err) };
    }

    return new Response(JSON.stringify(payload), { headers: CORS });
  },
};

/**
 * Fetch a URL with KV caching. ttl in seconds. headers optional (for auth).
 * Used for the slow football-data calls (60s is fine there).
 */
async function cachedFetch(env, cacheKey, url, ttl, headers) {
  const cached = await env.WC_KV.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const resp = await fetch(url, headers ? { headers } : {});
  const data = await resp.json();

  try {
    await env.WC_KV.put(cacheKey, JSON.stringify(data), {
      expirationTtl: Math.max(60, ttl),
    });
  } catch (e) { /* too large or write failed — still return data */ }

  return data;
}

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
  const data = await resp.json();

  const toCache = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl },
  });
  try { await cache.put(cacheUrl, toCache.clone()); } catch (e) {}

  return data;
}
