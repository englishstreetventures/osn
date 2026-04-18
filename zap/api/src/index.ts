import { cors } from "@elysiajs/cors";
import { healthRoutes, initObservability, observabilityPlugin } from "@shared/observability";
import { Effect, Logger } from "effect";
import { Elysia } from "elysia";

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
  // S-H3: fetching public keys over plaintext HTTP in a deployed env lets any
  // process with network access serve a forged JWK set. Fail fast.
  const jwksUrl = process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json";
  const nonLocal = process.env.OSN_ENV && process.env.OSN_ENV !== "local";
  if (nonLocal && jwksUrl.startsWith("http://")) {
    throw new Error("OSN_JWKS_URL must use HTTPS in non-local environments");
  }

  app.listen({ port, reusePort: false });
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
