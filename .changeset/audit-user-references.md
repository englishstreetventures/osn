---
"@osn/db": patch
"@osn/core": patch
"@osn/client": patch
"@osn/ui": patch
"@pulse/api": patch
"@pulse/app": patch
"@pulse/db": patch
---

Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.
