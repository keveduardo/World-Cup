# World-Cup

> **Archived 2026-09-11.** The 2026 World Cup ended in July 2026; this project
> is frozen, not deleted. The site (copa.brisaloca.com, GitHub Pages) and the
> `worldcup-proxy` Worker stay up so saved brackets still render, but the
> Worker's ungated `*.workers.dev` hostname is switched off and the API is
> served only on the `copa.brisaloca.com/api*` zone route (same origin as the
> site). The `WC_KV` namespace and the Worker were kept, untouched.
>
> **Where the data export lives:** every key in `WC_KV` on that date (20 keys,
> all `pool_player_*` brackets; the cache and favourites keys had already
> expired) was exported to
> - `r2://g10-backups/worldcup-kv-2026-09-11T143028Z.json` — the full, unredacted copy (the same bucket
>   `~/dev/backup/backup.sh` writes to; restore with
>   `npx wrangler r2 object get g10-backups/worldcup-kv-2026-09-11T143028Z.json --file out.json --remote`), and
> - [`archive/wc_kv-2026-09-11.json`](archive/wc_kv-2026-09-11.json) in this
>   repo — the same data with each key's personal code (the pool's login
>   credential) replaced by `sha256(code)[:12]`, because this repo is public.
>   Values (display name, picks, champion, avatar, pool, tiebreak) are unchanged;
>   no emails or other contact details were ever stored.
>
> To bring it back to life for another tournament, read `CLAUDE.md`.
