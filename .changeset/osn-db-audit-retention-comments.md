---
"@osn/db": patch
---

The `email_changes` and `security_events` schema comments say what is true: hard delete keeps both tables' rows with their `account_id`, which is why neither column has a foreign key to `accounts`, and nothing deletes the rows yet; `wiki/compliance/retention.md` sets their retention and lists the sweeper as planned. Comments only; no schema change.
