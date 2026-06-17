import { initObservability } from "@shared/observability";
import { Effect, Logger } from "effect";

import { createApp, SERVICE_NAME } from "./app";
import { assertCorsOriginsConfigured, isNonLocalEnv, resolveCorsOrigins } from "./lib/cors-config";
import { DEFAULT_JWKS_URL } from "./lib/jwks";
import { registerWithOsnApi } from "./services/zapGraphBridge";

// `local` environment entry point: long-lived Bun.serve process backed by
// bun:sqlite (the default `DbLive` layer inside `createApp`). The `dev` /
// `staging` / `prod` environments run the Workers entry (`index.ts`) over D1.
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

const nonLocal = isNonLocalEnv(process.env);

// S-H (mirrors pulse-api): fetching JWKS over plaintext HTTP in a deployed env
// lets any process with network access serve a forged key set. Fail fast.
if (nonLocal && DEFAULT_JWKS_URL.startsWith("http://")) {
  throw new Error("OSN_JWKS_URL must use HTTPS in non-local environments");
}

// S-M2: restrict CORS to a known origin allowlist instead of the open
// reflect-any default. Fail closed in non-local envs (empty allowlist throws).
const corsOrigins = resolveCorsOrigins(process.env);
assertCorsOriginsConfigured(corsOrigins, nonLocal);

const app = createApp({ jwksUrl: DEFAULT_JWKS_URL, corsOrigins });

const port = process.env.PORT || 3002;

app.listen({ port, reusePort: false });

void Effect.runPromise(
  Effect.logInfo("zap-api listening (local / bun:sqlite)").pipe(
    Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
    Effect.provide(Logger.pretty),
    Effect.provide(observabilityLayer),
  ),
);

// Register our ARC public key with osn/api so social-graph consent checks
// (Z3/Z4) can authenticate. Best-effort in local dev (a missing
// INTERNAL_SERVICE_SECRET logs a warning and boots); throws in non-local envs
// via the helper so a misconfigured deploy is caught at boot.
void registerWithOsnApi()
  .then((registered) => {
    if (registered) return;
    return Effect.runPromise(
      Effect.logWarning(
        "zap-api: ARC key registration skipped — INTERNAL_SERVICE_SECRET is unset. " +
          "Social-graph consent checks will fail closed (chats reject members) until it is set.",
      ).pipe(
        Effect.annotateLogs({ service: SERVICE_NAME }),
        Effect.provide(Logger.pretty),
        Effect.provide(observabilityLayer),
      ),
    ).catch(() => undefined);
  })
  .catch((err: unknown) => {
    void Effect.runPromise(
      Effect.logError("zap-api: failed to register ARC key with osn/api", err).pipe(
        Effect.annotateLogs({ service: SERVICE_NAME }),
        Effect.provide(Logger.pretty),
        Effect.provide(observabilityLayer),
      ),
    ).catch(() => undefined);
  });
