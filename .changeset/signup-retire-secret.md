---
"@osn/api": minor
"@osn/client": minor
"@osn/auth-ui": minor
"@shared/observability": patch
---

Starting a Musubi sign-up again from a new tab of the same browser, or after closing the waiting tab, mails the link at once instead of nothing for up to ten minutes. `@osn/api`'s `POST /register/begin` answers a `retireSecret` beside the claim secret, for a free, taken or held address alike, stored only as a SHA-256 hash. It can only end its request: no status poll, Resend, candidates read or confirm accepts it. Begin's `previous` is now `{ requestId, retireSecret }` (the claim secret is no longer taken there), and it retires the earlier request only when that request is for the address this begin is for; a wrong secret, the claim secret, an unknown request or another address retires nothing, at the same one store read and with the same answer. `@osn/client`'s `BegunRegistration` carries `retireSecret`, `PreviousRegistration` is `{ requestId, retireSecret }`, and the status poll and Resend take a `RegistrationClaim`. `@osn/auth-ui`'s `Register` keeps the claim secret in the tab's `sessionStorage` as before, and shares the live request's id, retire secret and expiry with the browser's other tabs in `localStorage` (`osn.signup.live`), nothing about the address; a tab that begins sends it as `previous`. The entry goes when its request ends, expires or is refused, and no tab removes another tab's entry. `@shared/observability` redacts `retireSecret` in logs.
