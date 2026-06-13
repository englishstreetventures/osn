# Cire

> A bespoke digital wedding invite experience

## Vision

Cire (French for "wax", as in a wax seal) is a digital wedding invite built to blur the lines between physical and digital. The immediate goal is a single, stunning digital wedding invite for a close friend — one that feels as considered and personal as a handcrafted paper invite, but with the interactivity and accessibility of the web.

The experience prioritises animation, tactile interactions, and modern form factors — View Transitions, AirDrop-style sharing, QR-coded claim codes printed on physical invites, and passkey-first authentication for organisers. Guests should feel like they've received something special, not just clicked a link.

If the result is polished enough, the longer-term vision is to platformise Cire as a service for couples — competing in the space of withjoy.com and missingpieceinvites.com, but with a stronger emphasis on physical/digital hybridity and modern web capabilities. The data model is already multi-tenant (a `weddings` root table) so that step is a product decision, not a migration.

## Architecture

Cire lives inside the **OSN monorepo** as the `cire/` workspace (merged from the standalone cire.git in June 2026):

```
cire/
├── web/          # @cire/web — Astro + SolidJS guest invite (Cloudflare Pages, :4321)
├── organiser/    # @cire/organiser — Astro + SolidJS organiser portal (:4322)
├── api/          # @cire/api — Elysia backend (Cloudflare Workers, :8787)
├── db/           # @cire/db — Drizzle schema + D1 migrations
└── wiki/         # Cire-internal Obsidian knowledge graph
```

OSN-facing integration docs live in the root wiki: `wiki/apps/cire.md` and `wiki/systems/cire-auth.md`.

## Apps & Services

| Name             | Description                                                                      | Status |
| ---------------- | -------------------------------------------------------------------------------- | ------ |
| `cire/web`       | Astro + SolidJS invite frontend with View Transitions and Motion One animations  | Active |
| `cire/organiser` | Organiser portal — guest/event dashboards + spreadsheet import, OSN passkey auth | Active |
| `cire/api`       | Elysia API on Cloudflare Workers — claim codes, RSVP, organiser API              | Active |
| `cire/db`        | Drizzle ORM schema and D1 migration files (multi-tenant `weddings` root)         | Active |

## Tech Stack

| Layer      | Technology                                                                    |
| ---------- | ----------------------------------------------------------------------------- |
| Runtime    | Bun + Cloudflare Workers                                                      |
| Frontend   | Astro + SolidJS + View Transitions                                            |
| Animations | Motion One (`@motionone/solid`) + Astro View Transitions                      |
| Backend    | Elysia on Cloudflare Workers + Effect (service layer)                         |
| Database   | Cloudflare D1 + Drizzle ORM + Effect                                          |
| Storage    | Cloudflare R2 (spreadsheet-import uploads)                                    |
| Auth       | Guests: claim-code → hashed session cookie. Organisers: OSN passkey (WebAuthn) — access JWTs verified via `@shared/osn-auth-client` |
| Testing    | bun:test (cire) — platform `it.effect` alignment tracked in root wiki TODO    |
| Linting    | oxlint (root config)                                                          |
| Formatting | oxfmt (root config)                                                           |
| Git hooks  | lefthook (root config)                                                        |
| CI/CD      | GitHub Actions → Cloudflare Pages + Workers                                   |

## Invite Access Model

Couples share a single URL. Guests enter a short claim code (e.g. `ROSE-4K7`) on arrival — printed on physical invites or shared in a group message. The code maps to their family's guest record and issues an opaque session cookie (hashed at rest, 30-day TTL). No individual link copy-pasting, no enumeration risk, guest list stays private. Guests never need an OSN account.

Organisers (the couple) sign in to the organiser portal with their **OSN passkey**; cire's API verifies OSN-issued access tokens against the OSN issuer's JWKS and gates every organiser route on wedding ownership.

## Contributing

OSN monorepo conventions apply: work on `feat/*` branches, PRs required to merge to `main`, every PR carries a changeset (`bun run changeset`). All commits are SSH-signed. Root lefthook enforces linting, formatting, type-checks, and dependency audit. See the repo-root `CLAUDE.md` and `README.md` for the full contribution guide.
