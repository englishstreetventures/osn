---
"@osn/api": patch
"@osn/db": patch
---

Email change and registration now correctly tell a real database fault apart from a genuine duplicate-address conflict, and a rate-capped account can no longer learn whether an email address is taken by watching which check fails first.
