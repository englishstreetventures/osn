import { initObservability } from "@shared/observability";
import { Effect, Logger } from "effect";

import { createApp, SERVICE_NAME } from "./app";

// `local` environment entry point: long-lived Bun.serve process backed by
// bun:sqlite (the default `DbLive` layer inside `createApp`). The `dev` /
// `staging` / `prod` environments run the Workers entry (`index.ts`) over D1.
const { layer: observabilityLayer } = initObservability({ serviceName: SERVICE_NAME });

const app = createApp();

const port = process.env.PORT || 3002;

app.listen({ port, reusePort: false });

void Effect.runPromise(
  Effect.logInfo("zap-api listening (local / bun:sqlite)").pipe(
    Effect.annotateLogs({ port: String(port), service: SERVICE_NAME }),
    Effect.provide(Logger.pretty),
    Effect.provide(observabilityLayer),
  ),
);
