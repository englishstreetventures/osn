---
"@musubi/infra": patch
"@musubi/social": patch
"@osn/api": patch
---

Stop exporting symbols used only inside their own file, drop re-exports nothing imports, and delete declarations nothing reads. No behaviour changes.
