---
"@osn/api": patch
---

Fix: register osn's outbound ARC public key with Pulse/Zap on the Cloudflare
Workers path before the account-erasure deletion fan-out.

Pulse + Zap verify osn's inbound ARC tokens against a **pre-registered** public
key (kid → registered key; no JWKS-by-kid pull). The Bun server registers that
key at boot via `startOutboundKeyRotation` (`local.ts`), but the workerd
`scheduled` handler — which runs the deletion fan-out and mints `account:erase`
ARC tokens — never did. The first `/internal/account-deleted` POST would be
401'd by the downstream and the GDPR Art. 17 erasure would stall (P6 finding).

The `scheduled` handler now calls a new `registerOutboundKeysOnce` (reusing the
existing `registerWithDownstream` logic) **before** the fan-out sweeps,
registering once per isolate (a module latch suppresses re-POSTing on later cron
ticks; the downstream upsert is idempotent regardless). A registration failure
is logged via `Effect.logError` and swallowed so a transient downstream outage
never aborts the cron — the latch only flips on full success, so the next tick
retries. The misleading "lazily inits on first outbound use" comment in
`src/index.ts` is corrected. No change to the Bun path.
