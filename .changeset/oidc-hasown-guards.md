---
"@osn/api": patch
"@osn/social": patch
---

Fix the three OIDC map-membership guards to use `Object.hasOwn` instead of
`in`, so an inherited `Object.prototype` key (`constructor`, `toString`,
`__proto__`) can no longer pass as a real map entry.
