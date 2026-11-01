import { Effect } from "effect";

import { CurrentBackgroundSink, withBackgroundSink } from "../../src/lib/background";

// Work a request starts and does not wait for — a mailed code, a tidying store
// call — runs after its answer (`forkBackground`). A test that reads what that
// work leaves behind waits for it through one of these, as the Worker's
// `waitUntil` would, rather than sleeping and hoping.

/** Runs `effect`, then waits for the background work it started. */
export const settle = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const pending: Promise<unknown>[] = [];
    const result = yield* effect.pipe(
      Effect.provideService(CurrentBackgroundSink, {
        add: (work) => {
          pending.push(work);
        },
      }),
    );
    yield* Effect.promise(() => Promise.all(pending));
    return result;
  });

/** `app.handle(request)`, then the background work the request started. */
export async function settledHandle(
  app: { handle(request: Request): Promise<Response> },
  request: Request,
): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await withBackgroundSink(
    {
      waitUntil: (work) => {
        pending.push(work);
      },
    },
    () => app.handle(request),
  );
  await Promise.all(pending);
  return response;
}
