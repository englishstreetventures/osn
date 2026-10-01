---
"@cire/api": patch
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
---

Naming a plus-one now checks the inviter's permission and the wedding's guest
cap inside the insert, so a revoke or another household's naming that lands in
between cannot slip one past either. The organiser and vendor portals reload
when the browser brings the dashboard back from its back/forward cache, and
send `Cache-Control: no-store` on it, so Back after sign-out cannot show the
signed-in page. The guest site's CSP names the cire-api of the build it ships
with, on every tier. The organiser portal's selected module label is painted in
`gold-ink`. The retention sweep runs two independent reads together.
