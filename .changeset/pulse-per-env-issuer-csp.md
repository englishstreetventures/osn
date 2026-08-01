---
"@pulse/app": minor
---

Read the API and OIDC issuer hosts from `VITE_API_URL` / `VITE_OSN_ISSUER_URL`
per build mode, and add a production Tauri config that narrows `connect-src` to
the hosts that environment actually talks to.
