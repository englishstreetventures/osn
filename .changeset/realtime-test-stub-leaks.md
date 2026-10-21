---
"@cire/api": patch
---

The realtime subscribe route's failed-lookup tests can fail again. Their stub
now throws a driver error that names the bound values and lets drizzle wrap it,
as it does on D1, so a change that logged the error's text would put a profile
id or a session token hash in the log and fail the test. The budget test fails
the insert, the statement that binds the profile id. Tests only; nothing that
ships changes.
