---
"@cire/host": patch
---

Host-dashboard UI polish: de-duplicate the masthead, consolidate on "host"
terminology, and move account actions under a profile menu.

- The masthead stacked two near-identical lines ("Organiser Portal" over
  "Organiser Dashboard"); it now reads Cire (eyebrow) over "Host Dashboard",
  and the tab titles follow ("Host Dashboard — Cire", "Sign in — Host
  Dashboard — Cire").
- User-facing copy says **host** instead of **organiser** everywhere: the RSVP
  provenance badge ("Host-entered" + its tooltip), the RSVP section intro, and
  the co-hosts panel's viewer description. API routes, component names, and
  code comments are unchanged.
- The top-level "Security" tab is gone from the section nav — account-scoped
  actions (Security & passkeys, Sign out) now live under a new avatar
  `ProfileMenu` (Kobalte dropdown) that names the signed-in account. The
  `#/security` deep link still works, and the view gains an "All weddings"
  back affordance.
