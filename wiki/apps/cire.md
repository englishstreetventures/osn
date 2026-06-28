---
title: Cire
description: Wedding-invite stack (guest site, organiser portal, API, DB)
tags: [app, weddings]
status: active
packages:
  - "@cire/web"
  - "@cire/organiser"
  - "@cire/api"
  - "@cire/db"
  - "@cire/landing"
related:
  - "[[cire-auth]]"
  - "[[cire-landing]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[turnstile]]"
  - "[[data-map]]"
  - "[[dpia/cire-guest-data]]"
last-reviewed: 2026-06-24
---

# Cire

Cire is a bespoke digital wedding invite — a tactile, animated guest-facing site plus an organiser portal for managing the guest list via spreadsheet import. It started life as a standalone repo (`cire.git`) and was merged into the OSN monorepo as a sibling workspace (`cire/*`, first in the root `workspaces` array). The data model is already multi-tenant (a `weddings` root table) so the bespoke build can platformise later without a schema rewrite.

## Packages

| Package | Dir | Port (dev) | Purpose |
|---|---|---|---|
| `@cire/web` | `cire/web` | 4321 | Guest-facing Astro + SolidJS site (claim code → events → RSVP) |
| `@cire/organiser` | `cire/organiser` | 4322 | Organiser portal (Astro + SolidJS) — guest/event tables, spreadsheet import, OSN passkey sign-in + inline account creation |
| `@cire/api` | `cire/api` | 8787 | Elysia on Cloudflare Workers + Effect services + Drizzle on D1 |
| `@cire/db` | `cire/db` | — | Drizzle schema + D1 SQL migrations |
| `@cire/landing` | `cire/landing` | 4323 | Static marketing site for the apex `cireweddings.com` — see [[cire-landing]] |

Note: `@cire/api` runs Elysia with `aot: false` — Elysia's ahead-of-time compilation builds handlers via `new Function`, which Cloudflare Workers forbids. Organiser auth uses the shared Elysia adapter (`@shared/osn-auth-client/middleware/elysia`), same as the other backends. (Migrated from Hono 2026-06-12 — see `[[changelog/completed-features]]`.)

## Auth model (summary)

Two deliberately separate systems — full contract in [[cire-auth]]:

- **Guests** never become OSN account holders. A family claim code (`families.public_id`, e.g. `SHARMA-IVY-QM42`) is exchanged at `POST /api/claim` for a 256-bit session token (SHA-256-hashed at rest), carried in a 30-day HttpOnly `cire_session` cookie. `sessionAuth()` gates `/api/rsvp`.
- **Organisers** sign in with their OSN passkey (via `@osn/client` + `@osn/ui` on the portal), or create a new OSN account inline — the portal's `SignInPanel` toggles between the `<SignIn>` and `<Register>` flows, so an organiser without an account never has to leave to register (the account is still created on OSN, not cire). **Any logged-in OSN user is a first-class organiser** (the old bootstrap-owner 503 gate is gone — #156, see below). `cire/api` verifies the resulting ES256 access JWT (`aud: "osn-access"`) against the OSN issuer's JWKS using `osnAuth()` from `@shared/osn-auth-client`; per-wedding authorization is enforced by two gates against `weddings.owner_osn_profile_id` + the `wedding_hosts` table — `weddingOwner()` (owner-only, destructive/management routes) and `weddingMember()` (owner **or** co-host, dashboard reads). Full contract in [[cire-auth]].
- **Multiple weddings + co-hosts** — an organiser lists / selects / creates weddings (`GET`/`POST /api/organiser/weddings`, #147); every wedding-scoped route carries an explicit `:weddingId` (the import routes were rescoped from global to `/api/organiser/weddings/:weddingId/import/*`). Co-hosts are added **by OSN handle** (#148): `cire/api` resolves the handle via an ARC-gated osn-api `GET /graph/internal/profile-by-handle` call and writes a `wedding_hosts` row; co-hosts get the read dashboard via `weddingMember()` but nothing destructive.
- **Optional guest account linking** (backend shipped; frontend deferred) — an invitee may attach their seat to an OSN/Pulse account. `POST /api/account/link` is the one dual-credential route (guest cookie + OSN token); it resolves the profile to an account id over ARC and writes `guest_account_links`. Full contract + the 401/dual-credential nuances in [[cire-auth]].

## Guest + organiser features (this session)

- **Per-section invite theming (#152)** — organisers theme each invite section with a bounded set of fonts + colours (migration `0014`). The allowlist is CSS-injection-safe: only known font keys and validated colour values reach the rendered styles, so a malicious value can't break out into arbitrary CSS.
- **Google Maps Embed preview (#146)** — venue/location previews use the Maps Embed API, key-optional with a CSS-card fallback when no key is set (same graceful-degradation pattern as Turnstile and the optional email).
- **Turnstile bot protection (#154)** — guest claim + RSVP (and the organiser-portal OSN register/login) are gated by Cloudflare Turnstile, key-optional + fail-closed; **inert until a widget is created**. See [[turnstile]].
- **Organiser Security / Devices section (#155)** — the portal's `SecurityPanel` mounts `@osn/ui`'s `PasskeysView` to list / add / rename / remove passkeys, with passkey-only step-up (the `passkeyOnly` flag on `StepUpDialog`). OTP step-up is suppressed because the deployed osn-api runs with email degraded ([[email]]), so an OTP couldn't be delivered; new-device help points at synced/backed-up passkeys, the cross-device QR ceremony, or a recovery code. See [[passkey-primary]], [[sessions]].

## Data model

- `weddings` is the root table; `families`, `events`, and `imports` carry a `wedding_id` NOT NULL FK (cascade). Multiple weddings per organiser are live (#147) — there is no longer a single seeded wedding.
- `weddings.owner_osn_profile_id` stores the owning OSN profile id as an opaque `usr_*` string — **no cross-DB FK** (cire's D1 and OSN's DB are separate databases). `wedding_hosts(wedding_id, osn_profile_id, …)` (#148) records co-hosts; unique per `(wedding_id, osn_profile_id)`. Owner + co-hosts are the `weddingMember()` set.
- `guest_account_links` records the optional per-invitee OSN link: `guest_id`/`family_id`/`wedding_id` (cascade FKs) + opaque `osn_account_id` / `osn_profile_id` (no cross-DB FK). See [[cire-auth]].
- **No bootstrap owner / no boot gate (#156).** Earlier builds seeded a demo wedding `wed_bootstrap` and gated the whole Worker on a `BOOTSTRAP_OWNER_PROFILE_ID` env var (`ensureBootstrapOwner` threw → 503 in any deployed tier until a real `usr_*` owner was set). That entire mechanism is **removed**: migration `0015_drop_bootstrap_wedding.sql` deletes the demo wedding, the env var + `ensureBootstrapOwner` + `resolveBootstrapOwnerProfileId` are gone, and a freshly signed-in account simply gets `GET /api/organiser/weddings → 200 {weddings: []}` and creates its first wedding. (Migration `0006_multi_tenant.sql` still uses the deliberate `__keep_*` snapshot/restore idiom for the multi-tenant scaffold — DROP TABLE under enforced FKs fires ON DELETE CASCADE into children on D1, verified empirically.)

## Local dev

```bash
bun run dev:cire   # @cire/api (:8787) + @cire/web (:4321) + @cire/organiser (:4322) + @osn/api (:4000)
```

`@osn/api` is included because organiser sign-in needs the OSN issuer (passkey ceremony + JWKS). The osn/api local-dev CORS fallback includes `http://localhost:4322` for the portal.

### Resetting / seeding the local DB

```bash
bun run db:reset                          # root: resets every app DB (osn/pulse/zap/cire)
bun run --cwd cire/db db:reset            # cire only: wipe local D1 → db:push → seed
bun run --cwd cire/db db:seed             # seed only (runs scripts/cire-db-seed.sh)
```

`scripts/cire-db-seed.sh` seeds the local miniflare D1 with a sample wedding
owned by `CIRE_DEV_OWNER_PROFILE_ID` so it shows under your signed-in dev
account. Set it in `cire/db/.env`:

```bash
CIRE_DEV_OWNER_PROFILE_ID=usr_<your-osn-profile-id>
```

The `cire/api` dev server (`local.ts`) seeds the same owner into its own
**in-memory** DB (not the persistent D1), so `bun run dev:cire` shows a wedding
under your account without a separate seed step. (Since #156 removed the
bootstrap-owner re-point machinery, the dev seed simply *creates* a wedding for
your profile rather than re-pointing a sentinel-owned demo row.) Both paths are
dev-only — neither runs in the deployed Worker (entry `src/index.ts`).
`cire/db` drizzle.config points `db:studio` at the local D1 sqlite (override via
`CIRE_DATABASE_URL`; the content-hashed path changes on `db:reset`).

## Deployment — live on `cireweddings.com`

The cire stack is **deployed in production** on `cireweddings.com` (Cloudflare
Free tier throughout — see [[free-tier-limits]]). Domains (#149):

| Host | Surface |
|---|---|
| `cireweddings.com` (apex) | guest site (`cire/web` Pages) |
| `app.cireweddings.com` | organiser portal (`cire/organiser` Pages) |
| `api.cireweddings.com` | `cire-api` Worker |
| `id.cireweddings.com` | `osn-api` Worker (the OSN issuer the organiser portal authenticates against) |

Passkey RP ID is `cireweddings.com`. Deploys run via the **GitHub Actions
workflow** (`.github/workflows/deploy.yml`): gated on a build/test job, it
applies the remote cire D1 migrations (incl. `0014` theming + `0015`
drop-bootstrap) and deploys the **cire-api Worker** + the **cire-web / organiser
Pages** projects on merge to main (repo secrets `CLOUDFLARE_API_TOKEN` /
`_ACCOUNT_ID` set). Prod wrangler config redeclares the D1 + R2 bindings under
`[env.production]` (named envs don't inherit top-level bindings); cire-api no
longer needs a bootstrap owner (#156). The full secret/var checklist, the
one-time Turnstile widget step, and post-deploy smoke checks live in the
[[production-deploy]] runbook.

## Cire-internal docs

Cire keeps its own knowledge graph: `cire/CLAUDE.md` is the AI entry point and `cire/wiki/` is the Obsidian vault (architecture, conventions, observability, per-area TODO shards under `cire/wiki/todo/`). This page and [[cire-auth]] cover the OSN-facing integration surface only.

## Marketing site + platform roadmap

The apex `cireweddings.com` is being given a dedicated **marketing site**,
`@cire/landing` — a static Astro brochure that opens with a wax-seal "unveil" and
markets the invite product (full design + deploy/migration plan in
[[cire-landing]]). The end-state packaging is three clean concerns on three
hosts: marketing (apex) · invites (`invite.cireweddings.com`) · organiser
(`host.cireweddings.com`).

Longer term, the ambition is to grow the organiser portal into a full wedding
**management platform** (withjoy-class), starting with a gift **registry** and
extending to budget / vendors / seating / timeline. The multi-tenant `weddings`
root means this is a product build-out, not a migration. Tracked under the Cire +
Landing sections of `wiki/TODO.md`.

## Future integrations

- **Pulse event feed** — surface cire weddings in Pulse's event feed. Mechanism undecided: ARC-token pull from `cire/api` vs push-on-publish into `pulse/db` (Deferred Decisions in `wiki/TODO.md`).
- **Roles for co-hosts** — co-host *membership* shipped (#148, `wedding_hosts` + `weddingMember()`); co-hosts currently get read-only dashboard access. A future role column (`owner`/`editor`/`viewer`) would let a co-host be granted write access short of full ownership.
- **Guest account-linking frontend** — backend shipped (see [[cire-auth]]); the guest-site "link my Pulse account" affordance is the remaining piece. Once invitees are linked, the Pulse event-feed integration above can surface their invitations.

## Compliance

Guest data (family/guest names, RSVP status, **special-category dietary
free-text**, claim codes) lives in cire's own Cloudflare D1 + R2 and is
recorded in the OSN compliance programme:

- [[data-map]] — cire section (fields, lawful basis, recipients); dietary Art. 9(2)(a) consent captured (C-H2 (cire dietary), PR #123); residual C-H1 R2 retention + C-L1 age-gate note
- [[dpia/cire-guest-data]] — Art. 35 DPIA (dietary special-category; gating consent mitigation RESOLVED PR #123, sign-off pending residual C-H1)
- [[retention]] — cire rows: guest data swept at 1 year (PR #132) + expired guest sessions swept daily (PR #127); R2-object lifecycle still open (C-H1)
- [[subprocessors]] — Cloudflare D1/R2 (guest-PII volume) + Pinterest embed (C-H3)
- privacy notice — guest site publishes `/privacy` + `/terms` (PR #124, C-H4); see [[changelog/compliance-fixes]]
- [[dsar]] — cross-DB reachability + orphan-tolerance decision (C-M1)
- [[access-control]] — cire D1/R2 operator access + the two cire credential classes (C-M3)
- [[soc2]] — `@cire/api` observability exception; redaction deny-list interim guard (C-M2)

## Related

- [[cire-landing]] — the marketing site for the apex + the domain migration / platform roadmap
- [[cire-auth]] — the two-auth-system contract (guest sessions + organiser OSN passkeys)
- [[identity-model]] — OSN accounts/profiles that organiser auth builds on
- [[passkey-primary]] — the passkey-only login model organisers use
- [[turnstile]] — bot protection on guest claim / RSVP + organiser register / login
- [[free-tier-limits]] — the Cloudflare Free-tier ceilings the deployed stack runs under
