import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTasksCache,
  ensureTasksLoaded,
  openTaskCount,
  type TaskRow,
  tasksAccessor,
} from "./tasks-store";

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "tsk_1",
  weddingId: "wed_1",
  title: "T",
  notes: null,
  timeframeBucket: "6m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  ...over,
});

beforeEach(() => __resetTasksCache());

describe("tasks-store", () => {
  it("loads once and reuses the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return [row({})];
    };
    await ensureTasksLoaded("wed_1", fetcher);
    await ensureTasksLoaded("wed_1", fetcher);
    expect(calls).toBe(1);
    expect(tasksAccessor("wed_1")()?.length).toBe(1);
  });

  it("openTaskCount counts only open tasks, null before load", async () => {
    expect(openTaskCount("wed_1")).toBeNull();
    await ensureTasksLoaded("wed_1", async () => [
      row({ id: "a", status: "open" }),
      row({ id: "b", status: "done" }),
      row({ id: "c", status: "open" }),
    ]);
    expect(openTaskCount("wed_1")).toBe(2);
  });
});
