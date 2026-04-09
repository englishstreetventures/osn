# @osn/osn

## 0.2.0

### Minor Changes

- cab97ca: Wire `@shared/observability` into OSN Core (auth + social graph) and the
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

### Patch Changes

- Updated dependencies [cab97ca]
- Updated dependencies [cab97ca]
  - @osn/core@0.6.0
  - @shared/observability@0.2.0

## 0.1.7

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
- Updated dependencies [97f35e5]
  - @osn/core@0.5.0
  - @osn/db@0.5.1

## 0.1.6

### Patch Changes

- Updated dependencies [cf57969]
  - @osn/core@0.4.0

## 0.1.5

### Patch Changes

- 3a0196b: Update CLAUDE.md with complete ARC token usage guidance: when to use ARC vs. direct package import, calling/receiving service patterns with code examples, and service registration steps.
- Updated dependencies [3a0196b]
  - @osn/core@0.3.2

## 0.1.4

### Patch Changes

- Updated dependencies [45248b2]
- Updated dependencies [45248b2]
  - @osn/db@0.5.0
  - @osn/core@0.3.1

## 0.1.3

### Patch Changes

- Updated dependencies [623ad9f]
  - @osn/db@0.4.0
  - @osn/core@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [9caa8c7]
  - @osn/db@0.3.0
  - @osn/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [05a9022]
  - @osn/db@0.2.3
  - @osn/core@0.1.1

## 0.1.0

### Minor Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

### Patch Changes

- Updated dependencies [75f801b]
  - @osn/core@0.1.0
  - @osn/db@0.2.2
