---
"@tools/e2e": patch
---

`pulse-event-rsvp` proves Pulse web's server rendering: with JavaScript off,
`/calendar` shows the host's and the guest's events with their cookies, and the
signed-out page with no cookie, an unknown one, an expired one, and one ended by
signing out everywhere or by "Log out"; a cross-site write is refused; the
callback's `Set-Cookie` carries no `Domain=`; and no browser request reaches
pulse-api's own origin. Calls through Pulse web's `/api` mount are recorded as
the same pulse-api calls (`API_MOUNTS`). The suite clock's dates name the
global `Date` as their constructor, which the clock probe now checks.
