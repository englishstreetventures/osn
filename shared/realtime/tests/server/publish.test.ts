import { Effect, Logger } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeHub } from "../support/fake-hub";

const { metricSignalPublished } = vi.hoisted(() => ({ metricSignalPublished: vi.fn() }));
vi.mock("../../src/server/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/metrics")>()),
  metricSignalPublished,
}));

import { publish, REVOKE_RETRY_DELAYS_MS } from "../../src/server/publish";

const TOPIC = "cire:wedding:wed_1";

beforeEach(() => metricSignalPublished.mockReset());

describe("publish", () => {
  it("hands the hub for the topic a signal and the subjects to evict and revoke", async () => {
    const { hub, publishes } = fakeHub({});
    const before = Date.now();

    await Effect.runPromise(
      publish(hub, TOPIC, "members-changed", {
        evictSubjects: ["usr_bob"],
        revokeSubjects: ["usr_eve"],
      }),
    );

    expect(publishes).toHaveLength(1);
    const [call] = publishes;
    expect(call?.name).toBe(TOPIC);
    expect(call?.signal.topic).toBe(TOPIC);
    expect(call?.signal.kind).toBe("members-changed");
    expect(call?.signal.at).toBeGreaterThanOrEqual(before);
    expect(call?.targets).toEqual({ evict: ["usr_bob"], revoke: ["usr_eve"] });
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "ok");
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

  describe("a publish that revokes", () => {
    const logged = () => {
      const messages: string[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(...(Array.isArray(message) ? message : [message]).map(String));
      });
      return { messages, layer: Logger.layer([logger]) };
    };

    it("tries the hub again when a call fails, and counts the one that lands", async () => {
      let calls = 0;
      const { hub, publishes } = fakeHub({
        publish: () => (++calls === 1 ? Promise.reject(new Error("hub down")) : Promise.resolve(1)),
      });
      const log = logged();

      await Effect.runPromise(
        publish(hub, TOPIC, "members-changed", {
          revokeSubjects: ["usr_eve"],
          revokeRetryDelaysMs: [1, 1],
        }).pipe(Effect.provide(log.layer)),
      );

      expect(publishes).toHaveLength(2);
      expect(publishes.map((call) => call.targets.revoke)).toEqual([["usr_eve"], ["usr_eve"]]);
      expect(metricSignalPublished).toHaveBeenCalledTimes(1);
      expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "ok");
      expect(log.messages).toEqual([]);
    });

    it("gives up after three calls, and says the revoke failed", async () => {
      const { hub, publishes } = fakeHub({ publish: () => Promise.reject(new Error("hub down")) });
      const log = logged();

      await expect(
        Effect.runPromise(
          publish(hub, TOPIC, "members-changed", {
            revokeSubjects: ["usr_eve", "usr_dee"],
            revokeRetryDelaysMs: [1, 1],
          }).pipe(Effect.provide(log.layer)),
        ),
      ).resolves.toBeUndefined();

      expect(publishes).toHaveLength(3);
      expect(log.messages).toEqual(["realtime revoke failed"]);
      expect(metricSignalPublished).toHaveBeenCalledTimes(1);
      expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "error");
    });

    it("waits before each retry, and only as long as it is told", async () => {
      const { hub, publishes } = fakeHub({ publish: () => Promise.reject(new Error("hub down")) });
      const started = Date.now();
      await Effect.runPromise(
        publish(hub, TOPIC, "members-changed", {
          revokeSubjects: ["usr_eve"],
          revokeRetryDelaysMs: [40],
        }),
      );
      expect(publishes).toHaveLength(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    });

    it("retries on its own pauses when told none", async () => {
      let calls = 0;
      const { hub, publishes } = fakeHub({
        publish: () => (++calls === 1 ? Promise.reject(new Error("hub down")) : Promise.resolve(1)),
      });
      const started = Date.now();
      await Effect.runPromise(
        publish(hub, TOPIC, "members-changed", { revokeSubjects: ["usr_eve"] }),
      );
      expect(publishes).toHaveLength(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(REVOKE_RETRY_DELAYS_MS[0] - 5);
      expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "ok");
    });

    it("tries a publish that revokes nobody once", async () => {
      const { hub, publishes } = fakeHub({ publish: () => Promise.reject(new Error("hub down")) });
      const log = logged();
      await Effect.runPromise(
        publish(hub, TOPIC, "tasks-changed", { revokeRetryDelaysMs: [1, 1] }).pipe(
          Effect.provide(log.layer),
        ),
      );
      await Effect.runPromise(
        publish(hub, TOPIC, "members-changed", {
          revokeSubjects: [],
          evictSubjects: ["usr_bob"],
          revokeRetryDelaysMs: [1, 1],
        }).pipe(Effect.provide(log.layer)),
      );
      expect(publishes).toHaveLength(2);
      expect(log.messages).toEqual(["realtime publish failed", "realtime publish failed"]);
    });
  });

  it("refuses a malformed topic without touching the hub", async () => {
    const { hub, publishes } = fakeHub({});
    await Effect.runPromise(publish(hub, "not a topic", "members-changed"));
    expect(publishes).toHaveLength(0);
    expect(metricSignalPublished).not.toHaveBeenCalled();
  });
});
