# World Cup Tracker — project guide for Claude Code

This is Kevin's (GitHub: `keveduardo`) 2026 FIFA World Cup tracker, live at **copa.brisaloca.com**.
Read this whole file before doing anything. When in doubt, ask before deploying.

---

## What this project is

- A **single-page app** in one file: `index.html` (~3,000 lines, vanilla JS, **no build step**). You edit the HTML/CSS/JS directly in that file.
- Served by **GitHub Pages** from this repo. A `CNAME` file maps it to `copa.brisaloca.com`. Pushing to the default branch auto-deploys.
- Backed by a **Cloudflare Worker** named `worldcup-proxy` (live at `worldcup-proxy.kevinamaya.workers.dev`). Its source of truth is **`worker.js`** in this repo. The Worker proxies/caches the data APIs and stores user data in a **KV namespace bound as `WC_KV`**.

### Worker endpoints (`worker.js`)
`?type=` → `matches` (football-data fixtures), `standings`, `espn` (live scores), `espnsummary&event=ID`, `favsave`/`favload` (team favorites), and the prediction pool: `poolload`, `poolsave`, `poolboard`.

### Data + secrets
- `matches`/`standings` come from **football-data.org** and need the Worker secret **`FOOTBALL_API_KEY`**.
- `espn` comes from ESPN's public scoreboard (no key), cached via Cloudflare's edge cache.
- **`POOL_CODE`** is the shared code people enter to join the prediction pool. It defaults to **`bubblers`** in code, so it works even if unset.

### KV keys in `WC_KV`
- Cache: `wc2026_matches`, `wc2026_standings`, `wc_sum_*`
- Favorites: `fav_<syncCode>`
- Pool entries: `pool_player_<personalCode>` → `{ name, picks, champion, updatedAt }`
**This is real user data — people's saved brackets and favorites live here. Treat it as production.**

### Notable features / functions (so you know what not to break)
- Tabs: Schedule, Groups & Standings, Knockout, Teams — plus a header **Pool** pill.
- `renderSchedule`, `renderGroups`, `renderKnockout`, `renderPlaceholderKO`, `renderTeams`, `renderPool`.
- **Clinch engine** (points-only, never shows a wrong team): `groupClinch` / `clinchAll` / `resolveKOSlot` — pre-fills clinched teams into the bracket and lists "possible opponents".
- **Prediction pool**: login by personal code; sign-up needs the pool code `bubblers`. Scoring/propagation logic lives in the pool module (`poolPick`, `savePool`, `poolScore`, `validateBracket`, etc.).
- `showTeam` opens the team modal; `rosterURL` builds Wikipedia links. Team names are clickable anywhere via a global `[data-team]` click handler.
- Shared helpers: `canonName`, `standingsMap`, `KO_SCHEDULE`, `loadMatches`, `loadEspnLive`.

---

## ONE-TIME SETUP — do this in the first session

**All project files are already in this folder and current** — `index.html`, `worker.js`, `wrangler.toml`, `.gitignore`, and this `CLAUDE.md`. You do **not** need to create any of them. The only blank to fill is the KV namespace `id` in `wrangler.toml` (step 3).

Goal: give yourself the ability to deploy the Worker and inspect KV. **I (Kevin) will do the browser approvals; you run the commands and guide me.**

1. **Install + authenticate Wrangler** (Cloudflare's CLI):
   ```
   npm install -g wrangler
   wrangler login
   ```
   `wrangler login` opens a browser for me to approve — that's my account, my click.

2. **Find the KV namespace id** (needed for `wrangler.toml`):
   ```
   wrangler kv namespace list
   ```
   (older wrangler: `wrangler kv:namespace list`). Note the `id` for the namespace used by `WC_KV`.

3. **Fill in `wrangler.toml`** (already in the folder): replace `PASTE_ID_HERE` with the namespace id from step 2. It already reads:
   ```toml
   name = "worldcup-proxy"
   main = "worker.js"
   compatibility_date = "2025-06-01"
   workers_dev = true

   [[kv_namespaces]]
   binding = "WC_KV"
   id = "PASTE_ID_HERE"
   ```
   Keep `binding = "WC_KV"` exactly as is, and use the real namespace `id` — if either is wrong, the deployed Worker loses access to favorites and pool data.

4. **Make sure the football-data key is set as a secret** (secrets persist across deploys and stay out of the repo):
   ```
   wrangler secret put FOOTBALL_API_KEY
   ```
   Paste the key when prompted. (Ask me for it — do not hardcode it anywhere.)

5. **Files are current.** The `index.html` and `worker.js` in this folder are the newest versions (Kevin placed them here, including the `bubblers` pool code, personal-code login, clinched-team bracket, and the Wikipedia roster-link fix). If the repo's committed versions differ, **these local files win** — commit them.

6. **First Worker deploy — carefully:**
   ```
   wrangler deploy
   ```
   Then immediately verify nothing broke by opening these:
   - `https://worldcup-proxy.kevinamaya.workers.dev/?type=matches` → normal match JSON (proves `FOOTBALL_API_KEY` survived).
   - `https://worldcup-proxy.kevinamaya.workers.dev/?type=poolboard&pool=bubblers` → `{"ok":true,...,"players":[...]}` (proves `WC_KV` is bound).
   If either fails, **stop** and tell me. Rollback is available in the Cloudflare dashboard under the Worker → Deployments.

7. **Secrets are already git-ignored.** The included `.gitignore` excludes `.dev.vars` and `.wrangler/`. Never commit the API key — it lives only as a Wrangler secret (`wrangler.toml` itself is safe to commit; the KV id isn't a secret).

---

## Everyday workflow

**Site change (`index.html`):**
1. Edit the file.
2. **Bump `APP_VERSION`** (a const near the top, e.g. `'2026-07-02.3'`) — this powers the
   auto-refresh: open tabs poll the live file, compare `APP_VERSION`, and reload (silently
   when backgrounded, or via a "Refresh/Actualizar" banner when foregrounded). If you don't
   bump it, users on old builds won't auto-update. Do this on **every** index.html deploy.
3. Verify (see Conventions below).
4. `git add -A && git commit -m "..." && git push` → GitHub Pages redeploys automatically.

**What's live now (as of 2026-07):** broadcast theme is the default look (day = bright pitch,
night = dark; 🌙/☀️ toggle; `?broadcast=0` for classic). Full **English⇆Spanish (Colombian)**
app-chrome toggle (🌐 ES/EN) via a `t('English')` dictionary (`I18N_ES`) + `data-i18n` for static
markup + `teamName()` for country names; °C when Spanish; **burns stay English** by design. A
third pool code **`familia`** starts at the Round of 16. See memory notes for details.

**Worker change (`worker.js`):**
1. Edit the file.
2. `wrangler deploy` (ask me first — this is production).
3. Re-check the two verify URLs above.
4. Commit `worker.js` to the repo too, so the repo stays the source of truth.

---

## Conventions (please follow)

- **Always sanity-check JS before deploying.** Extract the inline script from `index.html` and run `node --check` on it. For real logic (clinch math, pool scoring, bracket propagation), write a small throwaway Node harness and run it — this project has been built that way and it catches bugs before they ship.
- **Run the KO parity check before any deploy that touches kickoffs.** `node tools/ko-parity-check.mjs` asserts `KO_TIMES` (worker.js) and `KO_SCHEDULE` (index.html) agree on every match's date/ET. If they drift, the client can show a pick as editable while the server silently rejects it. If you change one, change both, then run this.
- **Don't disturb the big renderers.** When editing `renderKnockout`, `renderGroups`, or `renderPlaceholderKO`, keep changes surgical and additive; diff against the previous version to confirm only the intended lines changed.
- **Supervised deploys for the Worker.** Never auto-deploy `worker.js` or run destructive KV operations (delete/bulk-write) without explicit OK — real pool brackets and favorites are in `WC_KV`.
- **No secrets in the repo.** `FOOTBALL_API_KEY` is a Wrangler secret only.
- **Match existing style.** Vanilla JS, the project's CSS variables (`--pitch`, `--gold`, etc.), and the `canonName`/`standingsMap`/`KO_SCHEDULE` patterns already in the file.

## Handy Cloudflare/KV commands (read-only first)
```
wrangler deployments list                      # history / rollback reference
wrangler kv key list --binding WC_KV           # see stored keys
wrangler kv key get "pool_player_CODE" --binding WC_KV   # inspect one entry
wrangler tail                                  # live Worker logs
```
