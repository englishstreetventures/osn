---
"@pulse/api": patch
---

Fix `pulse-api` crashing at boot when `osn/api` is not yet reachable. `startKeyRotation()` now distinguishes network failures (explicit allowlist of Bun/Node codes: `ConnectionRefused`, `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`) from configuration errors: in local dev it logs a warning and schedules a background retry with exponential backoff (5 s → 5 min, ±1 s symmetric jitter) instead of exiting, so `bun run dev:pulse` tolerates either service starting first. Non-local envs and HTTP 4xx/5xx responses still fail fast so misconfiguration is surfaced immediately.
