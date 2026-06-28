---
"@cire/landing": minor
"@cire/web": patch
---

Add `@cire/landing` — the marketing site for the apex `cireweddings.com`.

A new static Astro + SolidJS + Tailwind v4 package whose brand tokens, fonts and
footer are kept identical to `cire/web`, so the page sells the invite product by
being a piece of it. It opens with the signature **wax-seal "unveil"** hero (an
envelope sealed with a gold wax disc that lifts, flap swinging open, to reveal the
headline + CTAs — keyboard-operable and reduced-motion aware), then an editorial
promise, alternating feature rows, how-it-works, a privacy/craft section, a FAQ
and the final CTA. Photography is hotlinked from Unsplash and centralised in
`lib/site.ts` so it (and the CTA targets) are one-line swaps.

The "See it live" section embeds a real, fully interactive invitation whose RSVP
is a deliberate **no-op** (nothing leaves the browser; test-asserted). A
testimonials section is fully designed but hidden behind a flag until real,
permissioned quotes exist.

`@cire/web`: the organiser **host-preview RSVP** — previously greyed out
(`disabled` in preview mode) — is now the same interactive no-op. The Respond
button stays enabled and the RSVP modal carries a `preview` flag that
short-circuits submit (no `/api/rsvp` POST) behind a "nothing you send here is
saved" banner, so a host can feel the exact guest flow without writing RSVP data.

Ships to a non-apex Cloudflare Pages preview; the apex cutover (invites →
`invite.`, organiser → `host.`, landing onto the apex) is a separate change. See
`wiki/apps/cire-landing.md`.
