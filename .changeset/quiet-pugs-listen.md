---
"@pulse/api": patch
---

Fix a private-event leak in `GET /events/today`. The feed ran no visibility predicate and the route extracted no claims, so every private event starting today was readable by an unauthenticated caller. `listTodayEvents` now takes the viewer's profile id (required, not defaulted) and filters through `buildVisibilityFilter`, the same predicate `listEvents` and `discoverEvents` already use; the route reads an optional bearer token so an organiser or an RSVP'd guest still sees their own private events.
