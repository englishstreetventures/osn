---
"@osn/social": patch
"@pulse/web": patch
---

Give the identity app and Pulse the privacy notices and terms they were already
promising.

`@osn/landing`'s notice says it "covers visitors to this site only" and that "the
OSN identity service and each connected app publish their own, separate privacy
notices". `@pulse/landing`'s says using the app "is governed by the OSN privacy
notice shown when you sign in". None of those notices existed, and neither app
carried a legal page or so much as a link to one — while holding accounts,
passkeys, sessions, the social graph, OIDC grants, events, RSVPs and location.

Both apps now serve `/privacy` and `/terms`, reachable without signing in, with
every claim taken from `wiki/compliance/data-map.md` — the lawful basis per
purpose, the real retention windows, and where the data is stored.

Two things the notices say that were not said anywhere before: Pulse's share
attribution records a platform name and nothing else, visible only to that event's
organiser, and it rests on legitimate interest you can object to; and attending an
event can reveal something protected about you even when the host published it
freely, so that is treated as needing consent rather than as manifestly public.
