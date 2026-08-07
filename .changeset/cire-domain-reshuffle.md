---
"@cire/invites": patch
"@cire/api": patch
"@cire/landing": patch
---

Domain reshuffle: guest invites → `invite.cireweddings.com`, organiser →
`host.cireweddings.com`, marketing landing → apex `cireweddings.com`.

Code side: `cire/invites/wrangler.jsonc` Worker route `cireweddings.com` →
`invite.cireweddings.com` (custom_domain auto-provisions on deploy); deploy.yml
`PUBLIC_SITE_URL`→`invite.`, `PUBLIC_CIRE_WEB_URL`→`invite.`,
`PUBLIC_ORGANISER_URL`→`host.`, landing `SITE`→apex; cire-api `WEB_ORIGIN` gains
`invite.`+`host.` (old apex+`app.` kept for the cutover window, pruned after).

No apex 301 for old invite links — there are no apex-based invite links in the
wild (guests use the full link). The remaining Cloudflare-dashboard steps (attach
`host.` to cire-organiser Pages, move the apex custom domain to cire-landing
Pages, confirm `invite.` on the Worker) + the osn-api manual redeploy are tracked
in `wiki/apps/cire-landing.md` → "Apex cutover" and the production-deploy runbook.
Passkeys are unaffected (`OSN_RP_ID` stays the registrable apex `cireweddings.com`).
