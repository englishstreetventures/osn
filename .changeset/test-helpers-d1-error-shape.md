---
"@cire/api": patch
---

The shared `failLikeD1` test helper gives a failed statement D1's own error
chain, `DrizzleQueryError` around a `D1_ERROR: <reason>` error around the
database's, instead of a second `DrizzleQueryError`; and `beforeStatement`
keeps a `failLikeD1` installed before it, so the two race tests that combine
them meet the D1 shape they name. Tests only; nothing that ships changes.
