# Cire

> A bespoke digital wedding invite experience

## Vision

Cire (French for "wax", as in a wax seal) is a digital wedding invite built to blur the lines between physical and digital. The immediate goal is a single, stunning digital wedding invite for a close friend — one that feels as considered and personal as a handcrafted paper invite, but with the interactivity and accessibility of the web.

The experience prioritises animation, tactile interactions, and modern form factors — View Transitions, AirDrop-style sharing, QR-coded claim codes printed on physical invites, and passkey-first authentication. Guests should feel like they've received something special, not just clicked a link.

If the result is polished enough, the longer-term vision is to platformise Cire as a service for couples — competing in the space of withjoy.com and missingpieceinvites.com, but with a stronger emphasis on physical/digital hybridity and modern web capabilities. That decision is deferred until the bespoke invite proves the concept.

## Architecture

Monorepo with two apps and a shared database package:

```
cire/
├── apps/
│   ├── web/          # Astro + SolidJS frontend (Cloudflare Pages)
│   └── api/          # Hono backend (Cloudflare Workers)
├── packages/
│   └── db/           # Drizzle schema + D1 migrations
└── package.json
```

## Apps & Services

| Name | Description | Status |
|---|---|---|
| `apps/web` | Astro + SolidJS invite frontend with View Transitions and Motion One animations | Planned |
| `apps/api` | Hono API on Cloudflare Workers — guest management, RSVP, auth, claim codes | Planned |
| `packages/db` | Shared Drizzle ORM schema and D1 migration files | Planned |

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun + Cloudflare Workers |
| Frontend | Astro + SolidJS + View Transitions |
| Animations | Motion One (`@motionone/solid`) + Astro View Transitions |
| Backend | Hono on Cloudflare Workers + Effect (service layer) |
| Database | Cloudflare D1 + Drizzle ORM + Effect |
| Storage | Cloudflare R2 (deferred) |
| Auth | Passkey (WebAuthn) + magic link email fallback; claim code invite system |
| Testing | Vitest |
| Linting | oxlint |
| Formatting | oxfmt |
| Git hooks | lefthook |
| CI/CD | GitHub Actions → Cloudflare Pages + Workers |

## Invite Access Model

Couples share a single URL. Guests enter a short claim code (e.g. `ROSE-4K7`) on arrival — printed on physical invites or shared in a group message. The code maps to their guest record and issues a passkey session. No individual link copy-pasting, no enumeration risk, guest list stays private.

## Contributing

Solo project. Work happens on `feat/*` branches off `main`. All commits are SSH-signed. lefthook enforces linting, formatting, and tests before every push. No PR review required — merge directly when ready.
