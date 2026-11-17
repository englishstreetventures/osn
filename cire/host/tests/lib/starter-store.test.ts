import { afterEach, describe, expect, it } from "vitest";

import {
  __resetStarterPreview,
  ensureStarterPreviewLoaded,
  hasStarterPreview,
  type StarterPreview,
} from "../../src/lib/starter-store";
import {
  __resetTasksCache,
  invalidateTasks,
  markTasksStale,
  rereadTasks,
  setCachedTasks,
  setFreshTasks,
  type TaskRow,
} from "../../src/lib/tasks-store";

/**
 * The starter checklist's preview says which items are already on the
 * checklist and which the couple deleted, so any change to the tasks makes a
 * cached preview wrong. Every way the tasks store learns of a change has to
 * mark the preview stale.
 */

const PREVIEW: StarterPreview = { weddingDate: "2099-06-20", items: [] };
const TASKS: TaskRow[] = [];

const changes: Record<string, (weddingId: string) => unknown> = {
  setCachedTasks: (id) => setCachedTasks(id, TASKS),
  setFreshTasks: (id) => setFreshTasks(id, TASKS),
  invalidateTasks,
  markTasksStale,
  rereadTasks: (id) => rereadTasks(id, async () => TASKS).catch(() => undefined),
};

describe("the cached starter preview", () => {
  afterEach(() => {
    __resetStarterPreview();
    __resetTasksCache();
  });

  for (const [name, change] of Object.entries(changes)) {
    it(`goes stale on ${name}`, async () => {
      await ensureStarterPreviewLoaded("wed_1", async () => PREVIEW);
      expect(hasStarterPreview("wed_1")).toBe(true);
      change("wed_1");
      expect(hasStarterPreview("wed_1")).toBe(false);
    });
  }
});
