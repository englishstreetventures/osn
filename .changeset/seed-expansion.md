---
"@osn/db": minor
"@pulse/db": minor
---

feat: expand seed data with 20 users, social graph, event RSVPs

- osn-db: 20 seed users with 25 connections and 3 close friends
- pulse-db: `event_rsvps` table for tracking attendance
- pulse-db: 15 seed events across 8 creators with 72 RSVPs
- Fix effect version alignment across all packages (resolves pre-existing type errors)
