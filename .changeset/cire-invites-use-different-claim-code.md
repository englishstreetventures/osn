---
"@cire/invites": patch
---

Add a guest sign-out control below the post-claim welcome section ("Not the
Okafor family? Sign out"), for a shared device or a code that opened the wrong
household's invite.

It is a real sign-out, not a local reset: it POSTs `/api/claim/signout` to
revoke the `cire_session` cookie server-side and drops the `cire_claimed`
restore hint, so a reload lands on the code form instead of silently
re-opening the household. The returned form is reset to a submittable state —
code, error, loading flag and the spent single-use Turnstile token all cleared,
the widget re-challenged — and focus moves to the code input.
