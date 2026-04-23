---
"@osn/api": patch
---

Fix CORS blocking handle checks and passkey flows from Tauri apps in local dev. `OSN_CORS_ORIGIN` now falls back to the actual monorepo frontend ports (`http://localhost:1420` for `@pulse/app`, `http://localhost:1422` for `@osn/social`) instead of the WebAuthn example-app origin (`5173`). Non-local envs still require `OSN_CORS_ORIGIN` to be set explicitly.
