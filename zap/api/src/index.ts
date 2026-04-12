import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { Effect, Logger } from "effect";
import { chatsRoutes } from "./routes/chats";

const SERVICE_NAME = "zap-api";
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

const app = new Elysia()
  .use(cors())
  .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
  .use(healthRoutes({ serviceName: SERVICE_NAME }))
  .get("/", () => ({ status: "ok", service: "zap-api" }))
  .use(chatsRoutes);

const port = process.env.PORT || 3002;

if (process.env.NODE_ENV !== "test") {
  app.listen(port);
  void Effect.runPromise(
    Effect.logInfo("zap-api listening").pipe(
      Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
      Effect.provide(Logger.pretty),
      Effect.provide(observabilityLayer),
    ),
  );
}

export { app };
export type App = typeof app;
