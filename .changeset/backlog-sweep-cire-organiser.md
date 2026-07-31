---
"@cire/organiser": patch
---

T-M2 (cire) — `cire/organiser/src/lib/api.ts` shipped untested. `isAuthExpired`
decides between "bounce the organiser to sign-in" and "show an error", so both
misclassifications are user-visible: a false negative leaves a dead dashboard
behind an expired cookie, a false positive throws someone out of a task
mid-edit. Its string-match arm is fragile, and it now has tests pinning the
shapes it must and must not accept.

Writing them found a real defect: `String(x)` throws on a null-prototype
object, so the predicate could throw from inside a `catch` block rather than
returning `false` — swapping a recoverable expiry for an unhandled rejection.
Guarded. Also covers `redirectToLogin`'s `returnTo` handling (same-origin path
only, never an absolute URL; `/login` is not remembered).
