import { cors } from "@elysiajs/cors";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { Effect, Logger } from "effect";
import { Elysia } from "elysia";

import { assertCorsOriginsConfigured, isNonLocalEnv, resolveCorsOrigins } from "./lib/cors-config";
import { DEFAULT_JWKS_URL } from "./lib/jwks";
import { chatsRoutes } from "./routes/chats";
import { registerWithOsnApi } from "./services/zapGraphBridge";

const SERVICE_NAME = "zap-api";
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

// S-H (mirrors pulse-api): fetching JWKS over plaintext HTTP in a deployed env
// lets any process with network access serve a forged key set. Fail fast at
// boot rather than silently trusting forged tokens.
const nonLocal = isNonLocalEnv(process.env);
if (nonLocal && DEFAULT_JWKS_URL.startsWith("http://")) {
  throw new Error("OSN_JWKS_URL must use HTTPS in non-local environments");
}

// S-M2 zap: restrict CORS to a known origin allowlist instead of the open
// reflect-any default. Fail closed in non-local envs (empty allowlist throws).
const corsOrigins = resolveCorsOrigins(process.env);
assertCorsOriginsConfigured(corsOrigins, nonLocal);

const app = new Elysia()
  .use(cors({ origin: corsOrigins, credentials: true }))
  .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
  .use(healthRoutes({ serviceName: SERVICE_NAME }))
  .get("/", () => ({ status: "ok", service: "zap-api" }))
  .use(chatsRoutes);

const port = process.env.PORT || 3002;

if (process.env.NODE_ENV !== "test") {
  app.listen({ port, reusePort: false });
  void Effect.runPromise(
    Effect.logInfo("zap-api listening").pipe(
      Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
      Effect.provide(Logger.pretty),
      Effect.provide(observabilityLayer),
    ),
  );

  // Register our ARC public key with osn/api so social-graph consent checks
  // (Z3/Z4) can authenticate. Best-effort in local dev (a missing
  // INTERNAL_SERVICE_SECRET logs a warning and boots); throws in non-local
  // envs via the helper so a misconfigured deploy is caught at boot.
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
}

export { app };
export type App = typeof app;
