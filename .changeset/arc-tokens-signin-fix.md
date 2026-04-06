---
"@osn/core": patch
---

Fix broken sign-in flow and add registration UI with handle claiming.

- **Bug fix:** Sign-in page was sending `{ email }` to all auth endpoints but the API expects `{ identifier }` — all three sign-in methods (passkey, OTP, magic link) returned 400 errors. Renamed field throughout the JS.
- **Improvement:** Login inputs now accept email or @handle (was email-only inputs, blocking handle-based sign-in).
- **Feature:** Added "Create account" tab to the hosted sign-in page with real-time handle availability checking (debounced against `GET /handle/:handle`), registration form (email, handle, optional display name), and automatic OTP verification flow after `POST /register` succeeds.
