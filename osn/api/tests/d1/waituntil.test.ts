import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

/**
 * Background work handed to `waitUntil`, on real workerd.
 *
 * This is the only tier that can observe the loss. On the Bun dev server a
 * bare `Effect.forkDetach` is neither interrupted nor awaited and the work
 * completes, so every vitest-tier assertion passes either way; on workerd, a
 * promise not handed to `ExecutionContext.waitUntil` may never run once the
 * response is returned. `?mode=bypass` forks with a bare `Effect.forkDetach`,
 * so the suite shows what is lost without the sink.
 */

// The fixture's work timer. The bypass case waits three times this long, so
// work that did survive the response would have finished by its read.
const WORK_MS = 250;

/** How long the sink case waits for the work before it fails. */
const DEADLINE_MS = 2_000;

let mf: Miniflare;

async function call(path: string): Promise<Record<string, unknown>> {
  const res = await mf.dispatchFetch(`http://example.com${path}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Reads `/state` until the work has completed; false once the deadline passes. */
async function sendCompletesWithin(deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- each read follows the last
    if ((await call("/state"))["sendCompleted"] === true) return true;
    if (Date.now() > end) return false;
    // eslint-disable-next-line no-await-in-loop -- the work runs in workerd, beyond any test clock
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  // `--target=node` keeps the `node:async_hooks` import that AsyncLocalStorage
  // needs; `--target=browser` strips it and workerd then dies with
  // "AsyncLocalStorage is not a constructor".
  const built = await Bun.build({
    entrypoints: [`${import.meta.dirname}/fixtures/waituntil-worker.ts`],
    format: "esm",
    target: "node",
  });
  if (!built.success) throw new AggregateError(built.logs, "fixture build failed");
  const script = await built.outputs[0]!.text();

  mf = new Miniflare({
    modules: true,
    script,
    // Matches osn/api/wrangler.toml exactly — the flags are what make
    // node:async_hooks resolve at all.
    compatibilityDate: "2025-03-01",
    compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
  });
});

afterAll(async () => {
  await mf?.dispose();
});

describe("background work on workerd", () => {
  it("hands the work to waitUntil and completes it after the response", async () => {
    const response = await call("/?mode=sink");

    // The user did not wait for it — that is the whole point of forking.
    expect(response["completedAtResponse"]).toBe(false);
    expect(response["handedToWaitUntil"]).toBe(1);

    expect(await sendCompletesWithin(DEADLINE_MS)).toBe(true);
  });

  it("drops the work when it bypasses the sink", async () => {
    const response = await call("/?mode=bypass");

    expect(response["completedAtResponse"]).toBe(false);
    // Nothing reaches waitUntil, so nothing holds the isolate open. This case
    // is the control for the one above: it shows the work is lost without
    // `waitUntil`, so the completion there comes from the sink. A
    // `forkBackground` that skipped the sink fails the case above, at its
    // `handedToWaitUntil` check.
    expect(response["handedToWaitUntil"]).toBe(0);

    await new Promise((r) => setTimeout(r, WORK_MS * 3));
    expect((await call("/state"))["sendCompleted"]).toBe(false);
  });
});
