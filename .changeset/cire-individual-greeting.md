---
"@cire/api": patch
"@cire/db": patch
"@cire/web": patch
"@cire/organiser": patch
---

Personalise the invite greeting by claim-code size. A code covering exactly one
guest is now greeted as an individual ("Dear {name}") instead of "The
{familyName} Family"; multi-guest codes keep the family greeting + member list.
Adds an optional "Guest Nickname" column to the organiser Guests CSV → a nullable
`guests.nickname` column (migration `0022_guest_nickname.sql`); the individual
greeting uses the nickname when set, else the first name (blank/whitespace ⇒
first name). Threaded CSV parse → import diff/apply → `/api/claim` members →
`FamilyMember.nickname` → `LoginSection` greeting. Organiser template + CSV
explainer surface the optional column. Additive and self-backfilling — existing
guests greet exactly as before until a nickname is set.
