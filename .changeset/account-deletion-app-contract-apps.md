---
"@pulse/api": minor
"@zap/api": minor
"@zap/db": minor
---

Pulse and Zap take part in account deletion. Pulse's preview lists the upcoming events a person hosts, one action per series and per other event (one for all past 100), with the 14-day cancellation as the default; its erasure takes the answers and `deleteEverything`, keeps a cancelled event 14 days for its guests or deletes it, deletes the person's series and web sessions, and answers what it kept. `POST /internal/account-sessions/revoke` ends a person's Pulse web sessions. Zap's preview lists nothing; its erasure removes the person's memberships, deletes a chat left with no one, replaces their sender id on what stays with a deletion sentinel and wipes the body of a plain-text message they wrote, recording each account in `zap_account_purges`. Both verify osn-api's ARC tokens against the keys osn-api publishes; Pulse's key registry and register-service routes are gone, and Zap's registry refuses keys for osn-api.
