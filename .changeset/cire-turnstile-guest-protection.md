---
---

cire: add Cloudflare Turnstile bot protection to the public guest surfaces (claim + RSVP), key-optional and fail-closed.

`cire-api` gains an optional Turnstile gate on `POST /api/claim` (the pre-auth claim-code oracle) and `POST /api/rsvp` (the spam-prone RSVP write). The verifier is built once per isolate in `src/index.ts` from `env.TURNSTILE_SECRET_KEY` via `@shared/turnstile` and threaded into `createApp`; `src/middleware/turnstile.ts` reads the body's `turnstileToken`, siteverifies it with the caller's `cf-connecting-ip`, and rejects with `403` on a missing/invalid/duplicate token. When the secret is unset the gate is a no-op (guest flow unchanged). New bounded metric `cire.turnstile.rejected{endpoint}`.

`cire/web` renders the challenge on the claim form (`LoginSection`) and the RSVP modal (`RsvpModal`) via a new key-optional `TurnstileWidget` Solid island that reads `PUBLIC_TURNSTILE_SITEKEY` (build-time). `cire/organiser` passes its build-time `PUBLIC_TURNSTILE_SITEKEY` into the shared `@osn/ui` `SignIn` + `Register` forms so organiser passkey sign-in is protected too. When the sitekey is unset, no widget renders and submit proceeds without a token — a pure enhancement that ships before the widget exists.

- Docs: `PUBLIC_TURNSTILE_SITEKEY` added to `cire/web` + `cire/organiser` `.env.example` and the deploy workflow (commented); `TURNSTILE_SECRET_KEY` + the dashboard widget-creation steps documented in `wiki/runbooks/production-deploy.md` §3.4.

`@cire/*` packages are version-less/ignored by changesets, so this is an empty changeset.
