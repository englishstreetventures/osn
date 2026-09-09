import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  CurrentBackgroundSink,
  currentBackgroundSink,
  forkBackground,
  withBackgroundSink,
} from "../../src/lib/background";
import { makeAppRunner } from "../../src/lib/route-runtime";
import { createTestLayer } from "../helpers/db";

/**
 * The two lines `runThroughExit` performs on every request: read the sink from
 * `AsyncLocalStorage` at the boundary, then carry it into the effect through
 * the reference. Mirrored rather than provided by hand, because the ALS-to-
 * reference bridge is the part of the design most likely to break silently —
 * providing the sink directly would pass even if that bridge were gone.
 */
const runLikeARoute = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => {
  const sink = currentBackgroundSink();
  return Effect.runPromise(sink ? Effect.provideService(eff, CurrentBackgroundSink, sink) : eff);
};

/**
 * The sink's own contract. The transport half — that what reaches `waitUntil`
 * actually keeps the isolate alive on workerd — is `tests/d1/waituntil.test.ts`,
 * because nothing at this tier runs workerd.
 */
describe("withBackgroundSink", () => {
  it("runs the handler untouched and collects nothing when there is no ExecutionContext", async () => {
    // The Bun dev server and every two-argument caller of the Worker handler
    // land here. Degrading, never throwing, is what keeps them working.
    let ran = false;
    const result = await withBackgroundSink(undefined, async () => {
      ran = true;
      return "ok";
    });

    expect(ran).toBe(true);
    expect(result).toBe("ok");
  });

  it("hands every registered promise to waitUntil, after the handler resolves", async () => {
    const handed: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => handed.push(p) };

    let handedAtResponse = -1;
    const result = await withBackgroundSink(ctx, async () => {
      await runLikeARoute(forkBackground(Effect.void));
      await runLikeARoute(forkBackground(Effect.void));
      handedAtResponse = handed.length;
      return "done";
    });

    expect(result).toBe("done");
    // Nothing is registered until the response is ready — the drain is
    // deliberately after `app.fetch` resolves, as the telemetry flush is.
    expect(handedAtResponse).toBe(0);
    expect(handed).toHaveLength(2);
    await Promise.all(handed);
  });

  it("settles the promise even when the background effect fails", async () => {
    // A send that fails must not wedge `waitUntil` — the observer fires on any
    // exit, not only on success.
    const handed: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => handed.push(p) };

    await withBackgroundSink(ctx, async () => {
      await runLikeARoute(forkBackground(Effect.fail("nope" as const)));
    });

    expect(handed).toHaveLength(1);
    await expect(Promise.all(handed)).resolves.toBeDefined();
  });

  it("is a no-op reference outside a request, so a service call still runs", async () => {
    // No `withBackgroundSink` frame at all: the default reference drops the
    // work on the floor, which is exactly what happened before this existed.
    let ran = false;
    await Effect.runPromise(
      forkBackground(
        Effect.sync(() => {
          ran = true;
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(ran).toBe(true);
  });

  it("is bridged by the real route runner, not only by this test's mirror", async () => {
    // The workerd fixture cannot import `makeAppRunner` — it pulls in
    // `@osn/db` and `@shared/email`, whose bundles carry a dynamic `import()`
    // Miniflare refuses. So the claim "`runThroughExit` reads ALS and provides
    // the reference" is pinned here instead, against the real runner. Delete
    // those two lines from `route-runtime.ts` and this goes red while every
    // other test stays green.
    const handed: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => handed.push(p) };
    const { run } = makeAppRunner(undefined, createTestLayer());

    await withBackgroundSink(ctx, async () => {
      await run(forkBackground(Effect.void));
    });

    expect(handed).toHaveLength(1);
    await Promise.all(handed);
  });

  it("reads the default sink when nothing provides one", async () => {
    const sink = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* CurrentBackgroundSink;
      }),
    );
    expect(() => sink.add(Promise.resolve())).not.toThrow();
  });
});
