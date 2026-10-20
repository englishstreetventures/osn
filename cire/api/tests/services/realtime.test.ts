import { describe, expect, it } from "bun:test";

import { realtimeSubscribeBudget } from "@cire/db";
import type { CloseTargets, HubNamespace } from "@shared/realtime/server";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { setExecutionCtx } from "../../src/lib/execution-ctx";
import { createWeddingSignals, spendRealtimeSubscribe } from "../../src/services/realtime";
import { counterValue } from "../test-helpers/metrics-harness";

function recordingHub(answer: () => Promise<number> = async () => 1) {
  const calls: { name: string; kind: string; targets: CloseTargets }[] = [];
  const hub: HubNamespace = {
    getByName: (name) => ({
      publish: async (signal, targets) => {
        calls.push({ name, kind: signal.kind, targets });
        return answer();
      },
      fetch: async () => new Response(null, { status: 426 }),
    }),
  };
  return { hub, calls };
}

const request = () => new Request("https://api.example.test/api/organiser/weddings/wed_1/hosts");

describe("wedding signals", () => {
  it("publishes members-changed on the wedding's topic, closing nobody by default", async () => {
    const { hub, calls } = recordingHub();
    await Effect.runPromise(createWeddingSignals(hub).membersChanged("wed_1", request()));
    expect(calls).toEqual([
      {
        name: "cire:wedding:wed_1",
        kind: "members-changed",
        targets: { evict: [], revoke: [] },
      },
    ]);
  });

  it("revokes the member who lost the dashboard, rather than evicting them", async () => {
    const { hub, calls } = recordingHub();
    await Effect.runPromise(
      createWeddingSignals(hub).membersChanged("wed_1", request(), "usr_bob"),
    );
    expect(calls[0]?.targets).toEqual({ evict: [], revoke: ["usr_bob"] });
  });

  it("sends nothing and never fails with no hub, counting the signal as disabled", async () => {
    const disabled = () =>
      counterValue("realtime.signal.published", {
        product: "cire",
        kind: "members-changed",
        result: "disabled",
      });
    const before = await disabled();
    await expect(
      Effect.runPromise(createWeddingSignals(undefined).membersChanged("wed_1", request())),
    ).resolves.toBeUndefined();
    expect(await disabled()).toBe(before + 1);
  });

  it("hands the publish to waitUntil, so the write does not wait on a hung hub", async () => {
    const { hub, calls } = recordingHub(() => new Promise(() => {}));
    const scheduled: Promise<unknown>[] = [];
    const req = request();
    setExecutionCtx(req, { waitUntil: (promise) => scheduled.push(promise) });

    const started = Date.now();
    await Effect.runPromise(createWeddingSignals(hub).membersChanged("wed_1", req));

    expect(Date.now() - started).toBeLessThan(500);
    expect(scheduled).toHaveLength(1);
    // The publish is under way in the background, not skipped.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
  });
});

describe("spendRealtimeSubscribe — the daily ceiling", () => {
  const spend = (db: Db, profile: string, perDay: number, now: Date) =>
    Effect.runPromise(
      spendRealtimeSubscribe(profile, perDay, now).pipe(Effect.provideService(DbService, db)),
    );
  const rows = (db: Db) => db.select().from(realtimeSubscribeBudget).all();
  const MORNING = new Date("2026-10-20T01:00:00Z");

  it("admits up to the ceiling, then refuses without writing", async () => {
    const db = createDb(":memory:");
    expect(await spend(db, "usr_a", 2, MORNING)).toBe(true);
    expect(await spend(db, "usr_a", 2, MORNING)).toBe(true);
    expect(await spend(db, "usr_a", 2, MORNING)).toBe(false);
    expect(await spend(db, "usr_a", 2, MORNING)).toBe(false);
    expect(rows(db)).toEqual([{ osnProfileId: "usr_a", day: "2026-10-20", subscribes: 2 }]);
  });

  it("counts each organiser apart", async () => {
    const db = createDb(":memory:");
    expect(await spend(db, "usr_a", 1, MORNING)).toBe(true);
    expect(await spend(db, "usr_a", 1, MORNING)).toBe(false);
    expect(await spend(db, "usr_b", 1, MORNING)).toBe(true);
  });

  it("starts each UTC day afresh and deletes the days before it", async () => {
    const db = createDb(":memory:");
    expect(await spend(db, "usr_a", 1, MORNING)).toBe(true);
    expect(await spend(db, "usr_b", 1, MORNING)).toBe(true);
    expect(await spend(db, "usr_a", 1, new Date("2026-10-20T23:59:59Z"))).toBe(false);
    expect(await spend(db, "usr_a", 1, new Date("2026-10-21T00:00:00Z"))).toBe(true);
    expect(rows(db)).toEqual([{ osnProfileId: "usr_a", day: "2026-10-21", subscribes: 1 }]);
  });

  it("refuses everything at a ceiling of zero", async () => {
    const db = createDb(":memory:");
    expect(await spend(db, "usr_a", 0, MORNING)).toBe(false);
  });
});
