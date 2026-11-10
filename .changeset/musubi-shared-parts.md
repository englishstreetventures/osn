---
"@osn/auth-ui": patch
"@musubi/social": patch
---

The auth views and Musubi's forms use the shared parts. A button that starts a wait shows it with `Button`'s `busy` ("Verifying…", "Creating…", "Saving…"): it keeps focus, draws the orb and refuses a second press, and only the button that started the wait is busy, so a resend in `Register` no longer marks "Verify email" as verifying. A Turnstile-gated submit stays busy, not disabled, after its spent token is dropped. Each form field is a `Field` with a plain label, 6px above its control; the views keep their own `Notice` error lines and tie them to the field. "Lost your passkey?" and "Resend code" are `Button` links centred under their action; `/authorize`'s "Create one", Discover's "Search for someone" and the legal pages' contact address are links inside a sentence. Working labels end in "…".
