---
"@osn/api": patch
---

Raise the per-IP rate limits on the auth endpoints that legitimately auto-fire,
which were tripping a 429 on normal sign-in. `passkey_login_begin` is fired by
the passkey **conditional-UI / autofill** ceremony on every login-page load, and
`handle_check` fires as-you-type during registration — both were capped at
10/min/IP, which a couple of page reloads exhausted. New per-IP/60s tiers:
`passkey_login_begin` 10 → **60**, `passkey_login_complete` 10 → **20**,
`handle_check` 10 → **30** (native Workers binding tiers + the local in-memory
mirror). The security-relevant gates (`register_complete`, `*_complete`,
step-up, recovery, email-change) are unchanged — begin is cheap and completion
still requires a valid assertion.
