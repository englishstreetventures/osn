---
"@pulse/app": minor
"@pulse/api": minor
"@pulse/db": minor
---

Add a Share button to event detail with source attribution. The picker
covers Instagram, Facebook, TikTok, X, WhatsApp, copy link, and a system
share-sheet fallback. Shared URLs carry a `?source=…` param so when the
recipient lands on the event we can record both first-touch (sticky) and
last-touch attribution on the RSVP row, plus per-platform share-invoked
and exposure metrics. Organisers' own self-RSVPs and self-views skip
attribution. Share and exposure endpoints are unauthenticated and
rate-limited per IP.
