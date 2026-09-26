import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeHub } from "../support/fake-hub";

const { metricSignalPublished } = vi.hoisted(() => ({ metricSignalPublished: vi.fn() }));
vi.mock("../../src/server/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/metrics")>()),
  metricSignalPublished,
}));

import { publish } from "../../src/server/publish";

const TOPIC = "cire:wedding:wed_1";

beforeEach(() => metricSignalPublished.mockReset());

describe("publish", () => {
  it("hands the hub for the topic a signal and the subjects to evict", async () => {
    const { hub, publishes } = fakeHub({});
    const before = Date.now();

    await Effect.runPromise(publish(hub, TOPIC, "members-changed", { evictSubjects: ["usr_bob"] }));

    expect(publishes).toHaveLength(1);
    const [call] = publishes;
    expect(call?.name).toBe(TOPIC);
    expect(call?.signal.topic).toBe(TOPIC);
    expect(call?.signal.kind).toBe("members-changed");
    expect(call?.signal.at).toBeGreaterThanOrEqual(before);
    expect(call?.evictSubjects).toEqual(["usr_bob"]);
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "ok");
  });

  it("evicts nobody unless asked", async () => {
    const { hub, publishes } = fakeHub({});
    await Effect.runPromise(publish(hub, TOPIC, "members-changed"));
    expect(publishes[0]?.evictSubjects).toEqual([]);
  });

  it("does nothing, and says so, when the product has no hub bound", async () => {
    await Effect.runPromise(publish(undefined, TOPIC, "members-changed"));
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "disabled");
  });

  it("succeeds when the hub rejects, and counts the error", async () => {
    const { hub } = fakeHub({ publish: () => Promise.reject(new Error("hub down")) });
    await expect(
      Effect.runPromise(publish(hub, TOPIC, "members-changed")),
    ).resolves.toBeUndefined();
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "error");
  });

  it("succeeds when getByName itself throws", async () => {
    const hub = {
      getByName: () => {
        throw new Error("binding broken");
      },
    };
    await expect(
      Effect.runPromise(publish(hub, TOPIC, "members-changed")),
    ).resolves.toBeUndefined();
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "error");
  });

  it("gives up on a hub that never answers, within the timeout", async () => {
    const { hub } = fakeHub({ publish: () => new Promise(() => {}) });
    const started = Date.now();
    await Effect.runPromise(publish(hub, TOPIC, "members-changed", { timeoutMs: 30 }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "error");
  });

  it("refuses a malformed topic without touching the hub", async () => {
    const { hub, publishes } = fakeHub({});
    await Effect.runPromise(publish(hub, "not a topic", "members-changed"));
    expect(publishes).toHaveLength(0);
    expect(metricSignalPublished).not.toHaveBeenCalled();
  });
});
