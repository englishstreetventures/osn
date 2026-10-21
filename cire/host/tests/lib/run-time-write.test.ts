import { beforeEach, describe, expect, it } from "vitest";

import { type RunTimePatch, saveTaskRunTime } from "../../src/lib/run-time-write";
import {
  __resetTasksCache,
  ensureTasksLoaded,
  peekCachedTasks,
  rereadTasks,
  type TaskRow,
} from "../../src/lib/tasks-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";

/**
 * Setting a task's time from the checklist row: one PATCH carrying the task's
 * whole run time, inside one of the portal's own task writes, so no read the
 * server answered from before it lands on top. The answer replaces the cached
 * row. An API older than run times answers 200 having ignored the field, and
 * that must never read as saved.
 */

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "tsk_1",
  weddingId: "wed_1",
  title: "Bring the rings",
  notes: null,
  timeframeBucket: "day_of",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  assigneeHostIds: [],
  ...over,
});

const linked = {
  ...row(),
  runAt: "2099-06-20T14:30:00+10:00",
  runTimezone: "Australia/Sydney",
  eventId: "evt_1",
  runOffsetMinutes: -30,
  anchored: true,
  eventRemoved: false,
};

type Sent = { url: string; init?: RequestInit };

function api(respond: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url: string, init?: RequestInit) => {
      sent.push({ url, init });
      return respond();
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  __resetWeddingScope();
  __resetTasksCache();
});

describe("saveTaskRunTime", () => {
  it.each<[string, RunTimePatch | null]>([
    ["a link by offset", { kind: "offset", eventId: "evt_1", offsetMinutes: -30 }],
    ["a link by clock time", { kind: "clock", eventId: "evt_1", at: "2099-06-20T14:30" }],
    ["a fixed time", { kind: "fixed", at: "2099-06-20T14:30", timezone: "Asia/Kolkata" }],
    ["no time", null],
  ])("sends %s as the task's whole run time, and keeps the answer", async (_label, runTime) => {
    await ensureTasksLoaded("wed_1", async () => [row(), row({ id: "tsk_2" })]);
    const server = api(() => json({ task: linked }));

    const result = await saveTaskRunTime(server.fetch, "wed_1", "tsk_1", runTime);

    expect(result).toEqual({
      ok: true,
      task: expect.objectContaining({ id: "tsk_1", anchored: true }),
    });
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.url).toMatch(/\/api\/organiser\/weddings\/wed_1\/tasks\/tsk_1$/);
    expect(server.sent[0]!.init?.method).toBe("PATCH");
    // Sent as JSON: the API reads a body by its content type.
    expect(new Headers(server.sent[0]!.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(server.sent[0]!.init?.body))).toEqual({ runTime });
    expect(peekCachedTasks("wed_1")?.find((t) => t.id === "tsk_1")).toMatchObject({
      runAt: "2099-06-20T14:30:00+10:00",
      runOffsetMinutes: -30,
    });
    expect(peekCachedTasks("wed_1")?.map((t) => t.id)).toEqual(["tsk_1", "tsk_2"]);
  });

  it("saves with no checklist cached, and caches nothing", async () => {
    const server = api(() => json({ task: linked }));
    const result = await saveTaskRunTime(server.fetch, "wed_1", "tsk_1", null);
    expect(result).toEqual({ ok: true, task: expect.objectContaining({ id: "tsk_1" }) });
    expect(peekCachedTasks("wed_1")).toBeNull();
  });

  it("reports a 200 from an API that ignored the run time as not saved, and keeps the row", async () => {
    await ensureTasksLoaded("wed_1", async () => [row()]);
    const {
      runAt: _r,
      runTimezone: _z,
      eventId: _e,
      runOffsetMinutes: _o,
      anchored: _a,
      eventRemoved: _x,
      ...older
    } = linked;
    const server = api(() => json({ task: older }));
    const result = await saveTaskRunTime(server.fetch, "wed_1", "tsk_1", {
      kind: "offset",
      eventId: "evt_1",
      offsetMinutes: -30,
    });
    expect(result).toEqual({ ok: false, reason: "not_saved" });
    expect(peekCachedTasks("wed_1")?.[0]?.runAt ?? null).toBeNull();
  });

  it.each([
    [422, { error: "event_not_in_wedding" }, "event_not_in_wedding"],
    [422, { error: "run_time_out_of_range" }, "out_of_range"],
    [422, { error: "something_else" }, "failed"],
    [400, { error: "Missing or invalid fields" }, "failed"],
    [404, { error: "task_not_found" }, "failed"],
    [500, { error: "Internal error" }, "failed"],
  ] as const)("reports %i %j as %s", async (status, body, reason) => {
    const server = api(() => json(body, status));
    const result = await saveTaskRunTime(server.fetch, "wed_1", "tsk_1", null);
    expect(result).toEqual({ ok: false, reason });
  });

  it("reports a signed-out answer, a network failure and an unreadable body", async () => {
    expect(await saveTaskRunTime(api(() => json({}, 401)).fetch, "wed_1", "tsk_1", null)).toEqual({
      ok: false,
      reason: "signed_out",
    });
    const expired = Object.assign(new Error("AuthExpiredError"), { _tag: "AuthExpiredError" });
    expect(
      await saveTaskRunTime(
        api(() => {
          throw expired;
        }).fetch,
        "wed_1",
        "tsk_1",
        null,
      ),
    ).toEqual({ ok: false, reason: "signed_out" });
    expect(
      await saveTaskRunTime(
        api(() => {
          throw new Error("offline");
        }).fetch,
        "wed_1",
        "tsk_1",
        null,
      ),
    ).toEqual({ ok: false, reason: "failed" });
    expect(
      await saveTaskRunTime(api(() => new Response("not json")).fetch, "wed_1", "tsk_1", null),
    ).toEqual({ ok: false, reason: "failed" });
  });

  it("holds a signal's re-read until the write has answered, and never leaves the write open", async () => {
    await ensureTasksLoaded("wed_1", async () => [row()]);
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const server = api(async () => {
      await answered;
      return json({ task: linked });
    });
    let reads = 0;
    const saving = saveTaskRunTime(server.fetch, "wed_1", "tsk_1", null);
    const reread = rereadTasks("wed_1", async () => {
      reads += 1;
      return [{ ...row(), ...linked }];
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(0);
    answer();
    await saving;
    await reread;
    expect(reads).toBe(1);

    // A failed write ends too: the next re-read goes at once.
    await saveTaskRunTime(api(() => json({}, 500)).fetch, "wed_1", "tsk_1", null);
    await rereadTasks("wed_1", async () => {
      reads += 1;
      return [row()];
    });
    expect(reads).toBe(2);
  });
});
