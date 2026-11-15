---
"@shared/osn-auth-client": minor
"@shared/crypto": minor
"@shared/observability": patch
"@shared/infra": patch
"@musubi/infra": patch
---

`@shared/osn-auth-client/arc` verifies an ARC token osn-api sent an app against the keys osn-api publishes, refusing a token from another issuer, for a scope the app does not let osn-api use, or whose kid fails its MAC, before fetching anything. `@shared/crypto/arc-kid` mints and checks those key ids; `@shared/crypto/arc-metrics` is a Worker-safe export of the ARC metrics. `DeletionRequestResult` gains `could_not_check` and `stale_choices`. The musubi stack gives osn-api Zap's address on dev and production and declares Pulse absent.
