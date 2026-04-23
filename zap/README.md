# Zap

OSN's end-to-end encrypted messaging app. `@zap/api` and `@zap/db` are
scaffolded (M0 done; M1 — 1:1 DMs over Signal — in flight on port
3002). The Tauri client `@zap/app` has not been started yet.
Implementation is tracked in [`../wiki/TODO.md`](../wiki/TODO.md) and
[`../wiki/apps/zap.md`](../wiki/apps/zap.md).

## Vibe

Somewhere between Messenger, Instagram, and iMessage. Playful but not
overbearing. Modern, secure, transparent.

## Why a separate top-level dir?

It mirrors `pulse/`. Each user-facing OSN app gets its own domain
directory + workspace prefix:

- `@zap/app` — Tauri + SolidJS frontend (planned)
- `@zap/api` — Elysia messaging backend (port 3002)
- `@zap/db` — Drizzle + SQLite schema (chats, messages, group state)

The Signal Protocol implementation lives in `@shared/crypto` (next to
ARC tokens), not in `zap/` — every OSN app that needs E2E messaging
consumes it from there.

## Planned features

### Core

- DMs and group chats
- Disappearing messages (optional)
- Themes
- Easter-egg mini-games
- Stickers and GIFs
- Polls
- AI model conversations (dedicated view)
- E2E security (Signal Protocol via `@shared/crypto`)

### Differentiator — Organisation chats

Verified organisations (Twitter-blue-tick style) operating support and
broadcast channels through a Zap handle instead of an email address.

- **Customer support via Zap handle** — businesses replace
  `support@acme.com` with `@acme` on Zap. Phishing surface drops because
  the verified organisation handle is the source of truth.
- **Embeddable web widget** — third-party sites swap their email-capture
  support widget for an "Enter your OSN handle" widget. The conversation
  surfaces in Zap under the verified organisation account, with full
  history and end-to-end auditability.
- **Government / locality channels** — users can opt in to a locality
  (their home city, plus temporary subscriptions when travelling). Local
  authorities can push official announcements (floods, evacuation
  notices, public safety) directly into a verified channel. Backed by an
  AI assistant so users can ask questions like "where's the nearest
  relief centre?" and get authoritative routed answers.
- **Backend tooling for organisations** — dashboards for triage, agent
  assignment, analytics, SLA monitoring. Eventually exposes hooks for
  e-commerce flows so a buyer can drop their OSN handle (or email) at
  checkout and continue support inside Zap.

## Two top-level views

1. **Socials** — DMs, group chats, organisation chats. Filterable by
   type and pinned/unread state.
2. **AI** — Dedicated view for conversations with AI models. Kept
   separate from Socials so the inbox isn't polluted by bot threads.

## Stack (planned)

Same as Pulse unless a real reason emerges:

| Layer           | Tool                                                |
| --------------- | --------------------------------------------------- |
| Runtime         | Bun                                                 |
| Frontend        | Tauri + SolidJS (iOS first)                         |
| Backend         | Elysia + Eden                                       |
| ORM / DB        | Drizzle + SQLite (→ Supabase later)                 |
| Functional core | Effect.ts                                           |
| Real-time       | WebSockets                                          |
| E2E             | Signal Protocol (`@shared/crypto`, planned)          |
| S2S auth        | ARC tokens (`@shared/crypto`)                        |
| Identity        | `@osn/api` via `@osn/client`                         |
| Shared UI       | `@osn/ui`                                            |
| Validation      | TypeBox at HTTP boundary, Effect Schema in services  |

The DB layer may diverge later (messages have very different access
patterns to events and users), but we'll cross that bridge when message
volume forces it.

## Build plan

See [`../wiki/TODO.md`](../wiki/TODO.md) — the **Zap** section breaks
the work into phases (M0 scaffold → M1 1:1 DMs → M2 groups →
M3 organisation chats → M4 polish + AI view).
