---
"@cire/api": patch
"@cire/invites": patch
"@cire/host": patch
"@cire/vendor": patch
"@cire/landing": patch
---

Run the cire devloop behind portless — `https://invite.cire.localhost`, `https://host.cire.localhost`, `https://vendor.cire.localhost`, `https://api.cire.localhost`, `https://cire.localhost` — instead of ports 4321-4326 and 8787.

The guest site's CSP gains one source, `https://*.localhost`, in `img-src` and `connect-src`: cire-api answers on `api.cire.localhost` under portless, branch-prefixed per worktree, so the exact host cannot be written down. `.localhost` is reserved and loopback-only, so it names nothing anyone else can serve — the same reasoning that already keeps `http://localhost:8787` in the production policy. Without it the devloop breaks the day the policy stops being Report-Only.

Each package's `dev` is now `portless`, with the real command in `dev:app` behind the `dev-env` launcher from `@shared/dev-urls`. The launcher fills in `WEB_ORIGIN`, `PUBLIC_API_URL`, `PUBLIC_OSN_ACCOUNT_URL` and the rest from the app's own portless hostname, so a worktree's surfaces always address that worktree's API rather than whichever stack happened to claim the port. The Astro ports moved into `astro.config.mjs`, which is what `PORTLESS=0` falls back to.
