---
"@osn/api": minor
---

Add `POST /authorize/decline`: a browser that reaches the consent screen without a session can refuse the sign-in request, and the app that asked gets the OAuth `access_denied` error at its registered redirect URI. The body is `{ requestId }`; the answer is `{ redirectTo }`, which the page navigates to. The route needs the request's binding cookie, answers an unknown, expired, answered or wrong-browser request with `400 invalid_request`, and draws on the same rate limit as `POST /authorize/decision`.
