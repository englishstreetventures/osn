import { describe, expect, it } from "bun:test";

import type { HubNamespace } from "@shared/realtime/server";
import { Effect } from "effect";

import { setExecutionCtx } from "../../src/lib/execution-ctx";
import { createWeddingSignals, weddingTopic } from "../../src/services/realtime";

function recordingHub(answer: () => Promise<number> = async () => 1) {
  const calls: { name: string; kind: string; evict: readonly string[] }[] = [];
  const hub: HubNamespace = {
    getByName: (name) => ({
      publish: async (signal, evict) => {
        calls.push({ name, kind: signal.kind, evict });
        return answer();
      },
      fetch: async () => new Response(null, { status: 426 }),
    }),
  };
  return { hub, calls };
}

const request = () => new Request("https://api.example.test/api/organiser/weddings/wed_1/hosts");

describe("wedding signals", () => {
  it("names a wedding's topic", () => {
    expect(weddingTopic("wed_1")).toBe("cire:wedding:wed_1");
  });

  it("publishes members-changed on the wedding's topic, evicting nobody by default", async () => {
    const { hub, calls } = recordingHub();
    await Effect.runPromise(
      createWeddingSignals(hub).membersChanged("wed_1", undefined, request()),
    );
    expect(calls).toEqual([{ name: "cire:wedding:wed_1", kind: "members-changed", evict: [] }]);
  });

  it("evicts the co-host whose seat changed", async () => {
    const { hub, calls } = recordingHub();
    await Effect.runPromise(
      createWeddingSignals(hub).membersChanged("wed_1", "usr_bob", request()),
    );
    expect(calls[0]?.evict).toEqual(["usr_bob"]);
  });

  it("does nothing, and never fails, with no hub", async () => {
    await expect(
      Effect.runPromise(
        createWeddingSignals(undefined).membersChanged("wed_1", undefined, request()),
      ),
    ).resolves.toBeUndefined();
  });

  it("hands the publish to waitUntil, so the write does not wait on a hung hub", async () => {
    const { hub, calls } = recordingHub(() => new Promise(() => {}));
    const scheduled: Promise<unknown>[] = [];
    const req = request();
    setExecutionCtx(req, { waitUntil: (promise) => scheduled.push(promise) });

    const started = Date.now();
    await Effect.runPromise(createWeddingSignals(hub).membersChanged("wed_1", undefined, req));

    expect(Date.now() - started).toBeLessThan(500);
    expect(scheduled).toHaveLength(1);
    // The publish is under way in the background, not skipped.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
  });
});
