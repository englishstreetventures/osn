---
"@pulse/api": patch
---

Fix pulse zapBridge test: mirror the new zap `chats.class` + `messages.body` columns (and nullable ciphertext/nonce) into the test's hand-rolled DDL, so it matches the c2b-chats schema change (Vendors S4 PR A / #286). Test-only; unblocks CI Build & Test.
