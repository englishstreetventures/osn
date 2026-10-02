// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, apiUrl: (path: string) => `https://api.test${path}` };
});

const downloadBlob = vi.fn();
vi.mock("../../src/lib/download", () => ({
  downloadBlob: (name: string, blob: Blob) => downloadBlob(name, blob),
}));

import {
  downloadLockedExport,
  fetchPlanningRows,
  LOCKED_EXPORTS,
  LockedExportError,
  lockedExportFor,
} from "../../src/lib/locked-exports";
import { isModuleLocked } from "../../src/lib/module-nav";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => downloadBlob.mockReset());

describe("LOCKED_EXPORTS", () => {
  // A module offers a locked download only when the tier that unlocks it is
  // one the wedding can lack. An export on a module that never locks would be
  // a card that never shows.
  it("names only modules an Ivory wedding sees locked", () => {
    for (const module of Object.keys(LOCKED_EXPORTS)) {
      expect(isModuleLocked(module as keyof typeof LOCKED_EXPORTS, "ivory")).toBe(true);
    }
  });

  it("maps the budget to budget.csv and the checklist to tasks.csv, and nothing else", () => {
    expect(lockedExportFor("budget")).toMatchObject({ path: "/budget.csv", count: "budgetLines" });
    expect(lockedExportFor("checklist")).toMatchObject({ path: "/tasks.csv", count: "tasks" });
    expect(lockedExportFor("registry")).toBeUndefined();
    expect(lockedExportFor("vendors")).toBeUndefined();
  });
});

describe("fetchPlanningRows", () => {
  it("reads the wedding's counts from planning-rows", async () => {
    const authFetch = vi.fn(async () => json({ budgetLines: 4, tasks: 12 }));
    expect(await fetchPlanningRows(authFetch, "wed_1")).toEqual({ budgetLines: 4, tasks: 12 });
    expect(authFetch).toHaveBeenCalledWith(
      "https://api.test/api/organiser/weddings/wed_1/planning-rows",
    );
  });

  it("reads a count that is missing or not a whole number as none", async () => {
    const authFetch = vi.fn(async () => json({ budgetLines: "4", tasks: -1 }));
    expect(await fetchPlanningRows(authFetch, "wed_1")).toEqual({ budgetLines: 0, tasks: 0 });
  });

  it("rejects with the status when the API refuses", async () => {
    const authFetch = vi.fn(async () => json({ error: "rate_limited" }, 429));
    const failure = fetchPlanningRows(authFetch, "wed_1");
    await expect(failure).rejects.toBeInstanceOf(LockedExportError);
    await expect(failure).rejects.toMatchObject({ status: 429 });
  });
});

describe("downloadLockedExport", () => {
  it("fetches the module's file and saves it under the API's name for it", async () => {
    const authFetch = vi.fn(
      async () => new Response("Timeframe,Task\r\n", { headers: { "content-type": "text/csv" } }),
    );
    await downloadLockedExport(authFetch, "wed_1", "our-day", LOCKED_EXPORTS.checklist);
    expect(authFetch).toHaveBeenCalledWith(
      "https://api.test/api/organiser/weddings/wed_1/tasks.csv",
    );
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob.mock.calls[0]![0]).toBe("cire-tasks-our-day.csv");
  });

  it("saves nothing when the API refuses", async () => {
    const authFetch = vi.fn(async () => json({ error: "forbidden" }, 403));
    await expect(
      downloadLockedExport(authFetch, "wed_1", "our-day", LOCKED_EXPORTS.budget),
    ).rejects.toMatchObject({ status: 403 });
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
