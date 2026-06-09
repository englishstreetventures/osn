---
title: "Cire TODO — deferred decisions"
tags: [todo, deferred]
related:
  - "[[index]]"
last-reviewed: 2026-06-08
---

# Deferred Decisions

Open architectural questions with options + a trigger for revisiting. When a decision lands, move the row from **Open** to **Resolved** with a one-line note.

## Open

| Question                                  | Options considered                                                                                        | Deadline / trigger                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Event invitations per-family vs per-guest | Per-guest matches sheet exactly (current schema); per-family simpler but loses fidelity                   | After first import lands and real spreadsheet variation is observed |
| Organiser auth model                      | Reuse passkey infra with role flag vs. separate `organisers` table                                        | Before `/api/organiser/import` is hardened                          |
| Surname collision handling in publicId    | Accept multiple `PATEL-*-*` IDs (different word/hash disambiguates) vs. enforce uniqueness on family_name | Stay on current accept-multiple unless aesthetic problem reported   |
| Astro → Solid Start migration             | Keep Astro+islands vs migrate guest-facing app to Solid Start for tighter SPA flows                       | Post-platformisation — only if SaaS direction is taken              |
| Platformise Cire                          | Multi-tenant SaaS vs stay bespoke                                                                         | After friend's wedding ships                                        |
| SMS OTP fallback                          | Twilio/similar vs email-only                                                                              | If magic link proves insufficient                                   |
| Seating planner                           | D1 table arrangement feature                                                                              | Post-MVP                                                            |
| Photo collections                         | Cloudflare R2 + upload UI                                                                                 | Post-MVP                                                            |
| Wishing well                              | Payment processing (requires ABN)                                                                         | After business is set up                                            |
| Guest photo sharing                       | R2 + moderation                                                                                           | Post-MVP                                                            |
| iPhone AirDrop sharing                    | Web Share API + custom payload                                                                            | After core invite is built                                          |

## Resolved

| Question                           | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Resolved   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Pinterest embed approach           | iframe for MVP (good-enough preview, no API rate limits); upgrade to static-image board snapshots post-launch                                                                                                                                                                                                                                                                                                                                                                      | 2026-05-05 |
| Pinterest embed approach (revised) | Script-widget (`<a data-pin-do>` + `pinit_main.js`) with a "View moodboard on Pinterest" link button fallback when `pinit_main.js` is blocked or fails to transform within 2.5s. Direct `<iframe src=.../embed.html>` was abandoned: `pinit_main.js` inside it silently bails on referrer / 3rd-party-storage / sandbox conditions and renders blank. Static-image snapshot path still available as a future upgrade if tracker-blocker fallback rates grow uncomfortable. PR #28. | 2026-06-08 |
| Spreadsheet input format           | CSV-only for MVP (two sheets: events + guests). `.xlsx` deferred — would need SheetJS, slower upload, and most organisers can export CSV from any tool.                                                                                                                                                                                                                                                                                                                            | 2026-05-05 |
