---
"@pulse/api": patch
"@osn/api": patch
---

Harden deployment posture and the Pulse Worker's JWKS scheme check.

- Pulse's Workers entry now fails closed when `OSN_JWKS_URL` is missing or
  plaintext `http://` in a non-local env (mirrors zap-api), so a misconfigured
  JWKS URL can't let a network attacker serve a forged key set.
- `workers_dev = false` on the top-level (env-less) wrangler configs for osn-api
  and cire-api, and the `deploy` scripts are now `wrangler deploy --env
  production`. A bare `wrangler deploy` (which binds the production D1 with a
  local security posture) now fails loudly instead of publishing a public shadow
  Worker. Real deploys go through `--env production`; CI migrations are
  unaffected.
