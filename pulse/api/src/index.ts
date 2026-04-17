import { cors } from "@elysiajs/cors";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { Effect, Logger } from "effect";
import { Elysia } from "elysia";

import { eventsRoutes, settingsRoutes } from "./routes/events";
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
  .use(settingsRoutes);

const port = process.env.PORT || 3001;

if (process.env.NODE_ENV !== "test") {
  if (!process.env.OSN_JWT_SECRET) {
    throw new Error("OSN_JWT_SECRET must be set");
  }

  app.listen({ port, reusePort: false });

  // Register our ephemeral public key with osn/api and schedule automatic
  // rotation. Exits the process if INTERNAL_SERVICE_SECRET is unset.
  void startKeyRotation().catch((err: unknown) => {
    console.error("pulse-api: failed to start ARC key rotation", err);
    process.exit(1);
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
