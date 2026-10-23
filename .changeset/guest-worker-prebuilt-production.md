---
"@shared/infra": minor
---

A prebuilt Worker uploads with Alchemy's default module rules plus `**/*.map`, and `planPrebuiltStage()` / `writePrebuiltStage()` stage a prebuilt build for that upload: every module byte for byte, and each module's source map as Wrangler's `upload_source_maps` sends it, with a refusal before anything is written for a missing or inlined map. On production, `apiWorkerProps()` now lets the guest site's Worker (`GUEST_WORKER`, cire-invites) trace, and refuses invocation logs on cire-api and cire-invites (`WEDDING_PATH_WORKERS`), whose request paths name weddings.
