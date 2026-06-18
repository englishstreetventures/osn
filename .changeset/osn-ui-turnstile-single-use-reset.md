---
"@osn/ui": patch
---

Fix organiser login loop: reset the Turnstile widget after every token-consuming
auth call so a single-use token is never replayed.

Once the production Turnstile sitekey + secret went live, `@osn/ui`'s `SignIn`
identifier-bound passkey form gated `/login/passkey/begin` on a Turnstile token.
Cloudflare tokens are **single-use**, and the component never retired the token
after `/begin` redeemed it — Cloudflare only auto-refreshes on the ~300s expiry,
not on consumption. So any retry (a cancelled WebAuthn ceremony, the wrong
passkey, a transient network error) re-submitted the already-redeemed token, the
server rejected it `timeout-or-duplicate` → `turnstile_failed`, and the user
bounced back to the login screen. Loop.

- `TurnstileWidget` now accepts an `onReady({ reset })` callback that hands the
  parent a bound `reset()` — it drops the stale token (`onToken(null)`) and asks
  Cloudflare for a fresh challenge.
- `SignIn` and `Register` call `reset()` immediately after each begin/register
  call that redeems the token, so the next submit always carries a fresh,
  unconsumed token. Removes the stale "the widget auto-refreshes" assumption in
  `Register.resendCode` that had the same latent single-use bug.

Regression tests: `SignIn` retries with a fresh token after a failed ceremony
(never replays the redeemed one); `TurnstileWidget.onReady` reset drops the token
and resets the widget instance.
