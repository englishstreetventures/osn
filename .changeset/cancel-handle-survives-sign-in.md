---
"@osn/api": patch
"@osn/db": patch
---

A sign-in on the browser holding the cancel handle of an account scheduled for deletion keeps that session live, so the account can still cancel, and marks it replaced in the new nullable `sessions.replaced_at` column; a token of it rotated out past the grace window still counts as reuse and ends it. A replaced session renews only for a profile its own account owns, whatever becomes of the deletion, and `/authorize` reads it as no session. An unmarked session of an account scheduled for deletion is refused a named profile its account does not own, and a renewal that read a session unmarked rotates nothing once a mark lands.
