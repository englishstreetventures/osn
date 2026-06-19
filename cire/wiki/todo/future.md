---
title: "Cire TODO — future / post-MVP"
tags: [todo, future]
related:
  - "[[index]]"
  - "[[invite-builder]]"
last-reviewed: 2026-06-19
---

# Future

Vague post-MVP ideas. Promote into a sibling shard (`web`, `api`, `db`, etc.) when an idea graduates to actionable work.

- Astro → Solid Start migration for the guest-facing app (post-platformisation, only if SaaS path is taken)
- Apple Wallet pass generation for each event
- Magic link email fallback (Resend)
- D1 migration + wrangler deploy path
- Platformise as multi-tenant wedding invite SaaS
- General wedding planning — guest list management, seating charts
- Physical + digital hybrid: QR codes on printed invites linking to digital counterparts
- Wishing well with payment processing
- Photo collection and guest photo uploads
- iPhone tip-to-tip AirDrop invite sharing
- White-label / custom domain support per wedding
- **Auto contrast-check the hero title vs the backdrop image** — deferred from `feat/hero-display-options`. Today the organiser manually picks the hero **title backdrop** (`none | solid`) for legibility over a busy/sharp photo. A future enhancement would sample the uploaded hero image's luminance behind the title region and auto-suggest (or auto-enable) the `solid` panel and/or flip the title colour when the WCAG contrast is too low — instead of leaving it to the organiser. Marked with a `// TODO(future)` in `cire/web/src/components/InviteHeader.tsx` (the title-block panel). See `[[invite-builder]]`.
