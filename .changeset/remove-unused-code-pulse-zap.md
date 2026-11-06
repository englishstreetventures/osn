---
"@pulse/api": patch
"@pulse/infra": patch
"@pulse/landing": patch
"@pulse/web": patch
"@zap/api": patch
"@zap/infra": patch
---

Stop exporting symbols used only inside their own file, drop re-exports nothing imports, and delete declarations nothing reads. No behaviour changes.
