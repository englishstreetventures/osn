import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

/**
 * The transport half of the background-work fix, on real workerd.
 *
 * This is the only tier that can observe the defect. On the Bun dev server a
 * bare `Effect.forkDetach` is neither interrupted nor awaited and the work
 * completes, so every vitest-tier assertion passes either way; on workerd, a
 * promise not handed to `ExecutionContext.waitUntil` may never run once the
 * response is returned. `?mode=bypass` drives the pre-fix code path, so the
 * red-proof lives in the suite rather than in a commit message.
 */

const WORK_MS = 250;

let mf: Miniflare;

async function call(path: string): Promise<Record<string, unknown>> {
  const res = await mf.dispatchFetch(`http://example.com${path}`);
  return (await res.json()) as Record<string, unknown>;
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

    await new Promise((r) => setTimeout(r, WORK_MS * 3));
    expect((await call("/state"))["sendCompleted"]).toBe(true);
  });

  it("drops the work when it bypasses the sink — the defect this fixes", async () => {
    const response = await call("/?mode=bypass");

    expect(response["completedAtResponse"]).toBe(false);
    // Nothing reaches waitUntil, so nothing holds the isolate open. This is
    // the exact assertion that goes red if `forkBackground` is ever reverted
    // to a bare `Effect.forkDetach` at a real call site.
    expect(response["handedToWaitUntil"]).toBe(0);

    await new Promise((r) => setTimeout(r, WORK_MS * 3));
    expect((await call("/state"))["sendCompleted"]).toBe(false);
  });
});
