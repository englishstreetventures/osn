---
"@cire/api": patch
---

Every per-IP limiter answers before any sign-in work. `osnAuth` and the wedding
role gates are Elysia resolves that run in `.use` order, and `osnAuthResolve` is
gone. Handle search, wedding create, preview-code, remint, mark-shared and the
registry contribute route mount their limiter first, so a refused request costs
no session lookup, token verify or role-gate query, and a caller who fails
sign-in spends the same per-IP budget as one who passes.
