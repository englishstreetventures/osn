---
"@cire/api": patch
---

Three unique conflicts answer their documented 409 on D1 rather than 500: a second account link for a seat (`already_linked`), a second upgrade press while one purchase is pending (`processing`), and a directory listing added twice to one wedding (`already_in_wedding`). Each reads the failed write through `driverErrorText` and matches the database's `table.column` wording, since on D1 the reason sits on the error's cause under a statement that names every column. An upgrade press that loses the insert to another now counts as `processing` in `cire.upgrade.checkout.started`. The co-host add matches the same way: only a failure on `wedding_hosts.osn_profile_id` reads as `already_host`, and a primary-key clash on a seat is a write error.
