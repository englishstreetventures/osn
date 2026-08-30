---
"@osn/api": patch
---

Cover the `/authorize` error page's copy and its own-property guard with
tests: each known error code now has its rendered wording pinned, an
unrecognised code is checked against its fallback text, a code named after a
built-in `Object.prototype` member (`constructor`) is checked against
leaking that built-in's own string form, a property planted on
`Object.prototype` is checked against being read as copy, and the
`rate_limited` variant is now exercised end to end through the route when
its rate limiter denies a request. `renderAuthorizeErrorPage` is exported
from `oidc.ts` so the unit-level cases can call it directly; its behaviour
is unchanged.
