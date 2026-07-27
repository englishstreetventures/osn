---
"@cire/organiser": patch
"@cire/vendor": patch
"@cire/api": patch
---

Remove the preview tier and give the login page two doors.

Identity moved to `musubi.social` on 2026-07-27, so the cireweddings.com origins
can no longer run a passkey ceremony: sign-in is a top-level redirect to
cire-api's OIDC start leg. `SignInPanel` therefore stops running the ceremony
itself and offers two buttons — *Continue with musubi* and *Create account with
musubi*. Both leave for the same issuer and end in the same place, a signed-in
organiser on the dashboard; the second only adds `prompt=create`, which asks the
consent screen to open on its sign-up half. It earns a button of its own because
someone here for the first time has no passkey to offer, and a screen demanding
one is a dead end rather than an invitation. The panel still explains a bounced
sign-in (`?auth_error=…`) and strips the marker. The 401 handler still sends
people to `/login`.

One thing does happen unbidden: behind the rendered page, both panels call
`resumeSession` from `@shared/rp-auth`, which asks `GET /api/auth/session` and
sends someone who still holds a cire session to the dashboard. Nobody should be
asked to sign in twice. It runs after the panel renders, so the usual visitor —
signed out — waits for nothing, and it only ever sees cire's own cookie: a
session at the issuer cannot be probed from this origin, which is the same
reason `prompt=none` stays off the start leg's allowlist.

`GET /api/auth/oidc/start` gained an optional `prompt`, **allowlisted to
`create`**. Every other value is dropped rather than rejected: the query string
is attacker-reachable, and forwarding it blind would let anyone turn a sign-in
link into `prompt=none` and ask for a grant with no screen at all.

The preview tier goes with it. A preview host could neither run the ceremony nor
replay a session cookie cross-site, and rebuilding it behind OIDC would need a
second client, a second consent record, and a second redirect URI. Deleted:
`[env.preview]` in `cire/api/wrangler.toml` (and the four `preview_bucket_name`
fields, which had no remote bucket left to bind),
`.github/workflows/deploy-cire-preview.yml`,
`.github/workflows/deploy-landing-preview.yml` — which pushed a feature branch
onto the production `cire-landing` project — and the `cire/db/seed/preview-seed`
pair. The Cloudflare resources (two Pages projects, two Workers, one D1, two R2
buckets) are deleted out of band.

Six open security and compliance findings close with the tier; they are archived
in the cire wiki's `security-fixes` changelog.
