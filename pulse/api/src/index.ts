import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { Effect, Logger } from "effect";
import { eventsRoutes, settingsRoutes } from "./routes/events";

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
  app.listen(port);
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
