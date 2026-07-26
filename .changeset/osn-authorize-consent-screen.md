---
"@osn/client": minor
"@osn/social": minor
---

OIDC consent screen. `@osn/client` gains `createAuthorizeClient` — two credentialed calls (`getContext`, `submitDecision`) against the parked authorize request, with an `AuthorizeError` that says whether the request is dead or whether signing in again fixes it. `@osn/social` gains the `/authorize` page it drives: client card, humanised scopes, profile picker when there is a real choice, and a `login_required` loop that holds the user's answer, re-authenticates and replays it against the same request id — but only after checking that the same account came back; a different sign-in drops the held answer and says so. `prompt=login` puts the ceremony before the decision, and a failed context read (a 429, a dropped connection) offers a retry instead of an endless spinner.

The page runs on a bare layout with no navigation out of the flow, and ships `frame-ancestors 'none'` so a consent screen can never be framed. Bare routes also run outside `AuthProvider`: mounting it bootstraps a session, which rotates the refresh token, and lists profiles the consent screen never reads. The provider now sits inside the sign-in island, which loads only when a ceremony is needed.
