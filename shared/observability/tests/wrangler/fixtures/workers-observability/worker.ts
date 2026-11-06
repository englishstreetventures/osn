/**
 * The fixture Worker for `../../workers-observability.e2e.ts`. It composes the
 * shared observability pieces the way osn-api and cire-api do — the handler
 * installs `ctx.tracing` first, and Effect runs on a module-scope runtime of the
 * redacting logger merged with `WorkersTracingLive` — and runs one probe per
 * request.
 *
 * The test sends two requests, `?role=a` and `?role=b`, at once. Each waits
 * until both have installed their `ctx.tracing`, so whichever ran last is the
 * installed one while both record spans: one request's spans are opened
 * through the other request's `ctx.tracing`.
 */
import { Data, Effect, Layer, ManagedRuntime } from "effect";

import { loadConfig } from "../../../../src/config";
import { makeLoggerLayer } from "../../../../src/logger/layer";
import { installWorkersTracing, WorkersTracingLive } from "../../../../src/tracing/workers";

/** The slice of the Workers `ExecutionContext` this fixture uses. */
interface Context {
  readonly tracing: unknown;
  waitUntil(promise: Promise<unknown>): void;
}

/** Appears in an attribute, an annotation and an error message; must reach no row. */
const PII = "ada@example.com";

class LookupFailed extends Data.TaggedError("LookupFailed")<{ readonly message: string }> {}

const runtime = ManagedRuntime.make(
  Layer.suspend(() =>
    Layer.merge(
      makeLoggerLayer(loadConfig({ serviceName: "observability-e2e", env: "dev" })),
      WorkersTracingLive,
    ),
  ),
);

const REQUESTS = 2;
let arrived = 0;

/**
 * Waits until every test request has arrived, polling on this request's own
 * timers. A request that awaits a promise another request resolves never
 * resumes on workerd, and a fiber another request's work resumes runs in that
 * request's I/O context, where workerd refuses console and tracing calls.
 */
const allArrived = async (): Promise<void> => {
  for (;;) {
    if (arrived >= REQUESTS) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const asyncResourceResolves = (): boolean => {
  const getBuiltinModule = (
    globalThis.process as { getBuiltinModule?: (id: string) => unknown } | undefined
  )?.getBuiltinModule;
  const hooks = getBuiltinModule?.("node:async_hooks") as { AsyncResource?: unknown } | undefined;
  return typeof hooks?.AsyncResource === "function";
};

const probe = (role: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`e2e ${role} looked up`).pipe(
      Effect.annotateLogs({ email: PII, weddingId: `wed_${role}` }),
    );

    const overlapped = arrived === REQUESTS;
    yield* Effect.gen(function* () {
      yield* Effect.sleep(5).pipe(Effect.withSpan(`e2e.${role}.child`));
      yield* Effect.fail(new LookupFailed({ message: `no row for ${PII}` })).pipe(
        Effect.withSpan(`e2e.${role}.failing`),
        Effect.ignore,
      );
    }).pipe(Effect.withSpan(`e2e.${role}.outer`, { attributes: { email: PII, kind: "probe" } }));

    yield* Effect.logError(`e2e ${role} failed once`);
    return overlapped;
  });

export default {
  async fetch(request: Request, _env: unknown, ctx: Context): Promise<Response> {
    installWorkersTracing(ctx.tracing);
    const role = new URL(request.url).searchParams.get("role") ?? "none";

    arrived += 1;
    await allArrived();

    const overlapped = await runtime.runPromise(probe(role));
    ctx.waitUntil(
      runtime.runPromise(
        Effect.sleep(20).pipe(
          Effect.andThen(Effect.void.pipe(Effect.withSpan(`e2e.${role}.background`))),
        ),
      ),
    );
    return Response.json({ role, overlapped, asyncResource: asyncResourceResolves() });
  },
};
