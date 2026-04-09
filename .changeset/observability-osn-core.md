---
"@osn/core": minor
"@osn/app": minor
---

Wire `@shared/observability` into OSN Core (auth + social graph) and the
OSN auth server (`@osn/app`).

**`@osn/core`**:

- New `src/metrics.ts` defines typed OSN Core counters and histograms:
  - `osn.auth.register.attempts{step,result}` + `.duration{step}`
  - `osn.auth.login.attempts{method,result}` + `.duration{method}`
  - `osn.auth.token.refresh{result}`
  - `osn.auth.handle.check{result}` (`available` / `taken` / `invalid`)
  - `osn.auth.otp.sent{purpose}` (`registration` / `login`)
  - `osn.auth.magic_link.sent{result}`
  - `osn.graph.connection.operations{action,result}`
  - `osn.graph.block.operations{action,result}`
- Curried pipe-friendly helpers (`withAuthRegister("begin")`,
  `withAuthLogin("passkey")`, `withGraphConnectionOp("request")`, …)
  attach a span AND record the outcome in a single `.pipe()` call.
  Duration histograms use the standard latency buckets from
  `@shared/observability`.
- `classifyError()` maps any caught Effect error into the bounded
  `Result` union so metric cardinality stays compile-time enforced.
- Auth service: `beginRegistration`, `completeRegistration`, `checkHandle`,
  `refreshTokens`, `beginPasskeyLogin`, `completePasskeyLogin`,
  `completePasskeyLoginDirect`, `beginOtp`, `completeOtp`,
  `completeOtpDirect`, `beginMagic`, `verifyMagic`, `verifyMagicDirect`
  are now instrumented with spans + metrics. OTP-sent and magic-link-sent
  counters fire on the happy path inside the relevant flows.
- Graph service: `sendConnectionRequest`, `acceptConnection`,
  `rejectConnection`, `removeConnection`, `blockUser`, `unblockUser` are
  instrumented with spans + typed graph counters.

**`@osn/app`**:

- Entry point now calls `initObservability({ serviceName: "osn-app" })`
  and wires up `observabilityPlugin` + `healthRoutes` (replacing the
  inline `/health` handler). Updated the existing test to match the new
  shared health-route shape (`{ status: "ok", service: "osn-app" }`).
- Structured boot log via `Effect.logInfo` instead of `console.log`.

**Under the hood**:

- `@shared/observability/src/tracing/layer.ts` now imports `NodeSdk`
  directly from the `@effect/opentelemetry/NodeSdk` subpath (not the
  root barrel) so that vitest doesn't eagerly try to resolve the
  optional `@opentelemetry/sdk-trace-web` peer dep the barrel's
  `WebSdk.js` module pulls in.

**Out of scope for this PR** (deliberately): migration of stray
`console.*` calls in auth flows (tracked as S-L8), WebSocket
instrumentation, dashboards and alerts, actual Grafana Cloud endpoint
provisioning.
