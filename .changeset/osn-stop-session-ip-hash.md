---
"@osn/api": patch
"@osn/db": patch
---

Sessions record no hash of the sign-in IP address: osn-api writes `sessions.ip_hash` on no session, copies it on no refresh and leaves it out of the account export's `sessions[]`, and the cross-device sign-in request keeps no IP hash for device B. Migration `20261119031316_clear_sessions_ip_hash` empties the column, and the Drizzle schema leaves it out (excused in the lockstep test) until a later release drops it. `security_events.ip_hash` stays, and the account export's `security_events[]` carries each event's `uaLabel` and `ipHash`, as `GET /account/security-events` does.
