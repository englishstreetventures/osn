---
"@pulse/api": minor
"@pulse/db": minor
"@pulse/app": minor
---

Event attendance visibility is `connections | no_one`. Close-friendship
is a one-way graph edge, so using it as an access gate would leak your
attendance to anyone you'd marked as a close friend regardless of
whether they reciprocated. Close-friends are a display signal only:
friendly attendees are surfaced first in `listRsvps` (via the
`isCloseFriend` row flag) and get the green ring affordance in
`RsvpAvatar`.

- `pulse_users.attendance_visibility` enum is `"connections" | "no_one"`.
- `filterByAttendeePrivacy` gates on the two buckets above.
- `listRsvps` fetches up to 200 rows, sorts close-friend rows to the top
  (stable sort preserves createdAt DESC within each bucket), then
  slices to the caller's requested limit — so even the 5-row inline
  strip reliably surfaces close friends when any exist.
