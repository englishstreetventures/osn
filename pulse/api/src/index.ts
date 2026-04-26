import { cors } from "@elysiajs/cors";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { Effect, Logger } from "effect";
import { Elysia } from "elysia";

import { closeFriendsRoutes } from "./routes/closeFriends";
import { eventsRoutes, settingsRoutes } from "./routes/events";
import { seriesRoutes } from "./routes/series";
import { startKeyRotation } from "./services/graphBridge";

// Initialise observability (logger, tracing, metrics) before building the app.
// No-op in test runs — tests never call listen() so the layer is never provided.
const SERVICE_NAME = "pulse-api";
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

const app = new Elysia()
  .use(cors())
  .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
  .use(healthRoutes({ serviceName: SERVICE_NAME }))
  .get("/", () => ({ status: "ok", service: "osn-api" }))
  .use(eventsRoutes)
  .use(seriesRoutes)
  .use(settingsRoutes)
  .use(closeFriendsRoutes);

const port = process.env.PORT || 3001;

if (process.env.NODE_ENV !== "test") {
  // S-H3: fetching public keys over plaintext HTTP in a deployed env allows
  // any process with network access to serve a forged JWK set. Fail fast.
  const jwksUrl = process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json";
  const nonLocal = process.env.OSN_ENV && process.env.OSN_ENV !== "local";
  if (nonLocal && jwksUrl.startsWith("http://")) {
    throw new Error("OSN_JWKS_URL must use HTTPS in non-local environments");
  }

  app.listen({ port, reusePort: false });

  // Register our ephemeral public key with osn/api and schedule automatic
  // rotation. Exits the process only on unrecoverable errors (missing
  // secret in non-local, HTTP 4xx/5xx, etc). In local dev, a missing
  // secret or an unreachable osn/api logs a warning and lets the server
  // boot — the latter schedules a background retry so `bun run dev:pulse`
  // is resilient to turbo starting both services in parallel.
  void startKeyRotation()
    .then((status) => {
      if (status === "registered") return;
      const warning =
        status === "skipped-secret-unset"
          ? "pulse-api: ARC key registration skipped — INTERNAL_SERVICE_SECRET is unset. " +
            "S2S calls to osn/api will fail until you set INTERNAL_SERVICE_SECRET in pulse/api/.env " +
            "(matching the value in osn/api/.env)."
          : "pulse-api: osn/api is not reachable yet — retrying ARC key registration in the background. " +
            "This is expected when pulse-api starts before osn/api (e.g. under `bun run dev:pulse`).";
      return Effect.runPromise(
        Effect.logWarning(warning).pipe(
          Effect.annotateLogs({ service: SERVICE_NAME }),
          Effect.provide(Logger.pretty),
          Effect.provide(observabilityLayer),
        ),
      ).catch(() => undefined);
    })
    .catch((err: unknown) => {
      void Effect.runPromise(
        Effect.logError("pulse-api: failed to start ARC key rotation", err).pipe(
          Effect.annotateLogs({ service: SERVICE_NAME }),
          Effect.provide(Logger.pretty),
          Effect.provide(observabilityLayer),
        ),
      )
        .catch(() => {})
        .finally(() => process.exit(1));
    });

  // One structured info log at boot, routed through the observability layer
  // so it picks up resource attributes + redaction. Using Effect.runPromise
  // because the layer is Effect-scoped.
  void Effect.runPromise(
    Effect.logInfo("pulse-api listening").pipe(
      Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
      Effect.provide(Logger.pretty),
      Effect.provide(observabilityLayer),
    ),
  );
}

export { app };
export type App = typeof app;
