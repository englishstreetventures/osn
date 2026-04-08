# Zap

OSN's messaging app. **Not yet built** — this directory is a placeholder
that pins the name and the planned workspace layout. Implementation is
tracked under the **Zap (`zap/app` + `zap/api` + `zap/db`)** section in
[TODO.md](../TODO.md).

## Vibe

Somewhere between Messenger, Instagram, and iMessage. Playful but not
overbearing. Modern, secure, transparent.

## Why a separate top-level dir?

It mirrors `pulse/`. Each user-facing OSN app gets its own domain
directory + workspace prefix:

- `@zap/app` — Tauri + SolidJS frontend
- `@zap/api` — Elysia + Eden messaging backend (port TBD)
- `@zap/db`  — Drizzle + SQLite schema (chats, messages, group state)

The Signal Protocol implementation lives in `@osn/crypto` (next to ARC
tokens), not in `zap/` — every OSN app that needs E2E messaging consumes
it from there.

## Planned features

### Core
- DMs and group chats
- Disappearing messages (optional)
- Themes
- Easter-egg mini-games
- Stickers and GIFs
- Polls
- AI model conversations (dedicated view)
- E2E security (Signal Protocol via `@osn/crypto`)

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

| Layer            | Tool |
|------------------|------|
| Runtime          | Bun |
| Frontend         | Tauri + SolidJS (iOS first) |
| Backend          | Elysia + Eden |
| ORM / DB         | Drizzle + SQLite (→ Supabase later) |
| Functional core  | Effect.ts |
| Real-time        | WebSockets |
| E2E              | Signal Protocol (`@osn/crypto`) |
| S2S auth         | ARC tokens (`@osn/crypto/arc`) |
| Identity         | OSN Core (`@osn/client`) |
| Shared UI        | `@osn/ui` |
| Validation       | TypeBox at HTTP boundary, Effect Schema in services |

The DB layer may diverge later (messages have very different access
patterns to events and users), but we'll cross that bridge when message
volume forces it.

## Build plan

See [TODO.md](../TODO.md) — the **Zap (`zap/app` + `zap/api` + `zap/db`)**
section breaks the work into phases (M0 scaffold → M1 1:1 DMs → M2
groups → M3 organisation chats → M4 polish + AI view).
