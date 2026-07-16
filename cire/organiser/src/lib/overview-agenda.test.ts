import { describe, expect, it } from "vitest";

import { buildAgenda, toLocalDateKey, type AgendaInput } from "./overview-agenda";

// A fixed "now": 2026-07-16 (local). All fixture dates are relative to this.
const NOW = new Date(2026, 6, 16, 9, 0, 0).getTime();

function input(over: Partial<AgendaInput>): AgendaInput {
  return {
    events: [],
    payments: [],
    tasks: [],
    now: NOW,
    currency: "AUD",
    horizonDays: 90,
    limit: 6,
    ...over,
  };
}

describe("toLocalDateKey", () => {
  it("normalises ISO datetime, YYYY-MM-DD, and ms-epoch to a local date key", () => {
    expect(toLocalDateKey("2026-08-03")).toBe("2026-08-03");
    // An ISO datetime at local midday stays on the same local day.
    expect(toLocalDateKey(new Date(2026, 7, 3, 12, 0, 0).toISOString())).toBe("2026-08-03");
    expect(toLocalDateKey(new Date(2026, 7, 3, 0, 0, 0).getTime())).toBe("2026-08-03");
  });

  it("returns null for garbage", () => {
    expect(toLocalDateKey("not-a-date")).toBeNull();
    expect(toLocalDateKey(Number.NaN)).toBeNull();
  });

  it("buckets ISO datetime with explicit offset to its LOCAL calendar day", () => {
    const lateLocal = new Date(2026, 7, 3, 23, 30, 0); // 2026-08-03 23:30 local
    expect(toLocalDateKey(lateLocal.toISOString())).toBe("2026-08-03");
  });
});

describe("buildAgenda", () => {
  it("merges events, unpaid payments, and open tasks sorted ascending by date", () => {
    const a = buildAgenda(
      input({
        events: [{ id: "e1", name: "Rehearsal", startAt: new Date(2026, 7, 12, 18).toISOString() }],
        payments: [
          {
            id: "p1",
            label: "Venue balance",
            amountMinor: 800000,
            dueAt: "2026-08-03",
            paidAt: null,
          },
        ],
        tasks: [{ id: "t1", title: "Confirm florist", dueAt: "2026-08-09", status: "open" }],
      }),
    );
    expect(a.map((i) => i.label)).toEqual(["Venue balance", "Confirm florist", "Rehearsal"]);
    expect(a.map((i) => i.kind)).toEqual(["payment", "task", "event"]);
    expect(a[0]!.detail).toBe(
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "AUD",
        maximumFractionDigits: 0,
      }).format(8000),
    );
    expect(a[0]!.key).toBe("payment:p1");
  });

  it("excludes past events, paid payments, done tasks, and undated payments/tasks", () => {
    const a = buildAgenda(
      input({
        events: [{ id: "e1", name: "Past party", startAt: new Date(2026, 5, 1).toISOString() }],
        payments: [
          { id: "p1", label: "Paid deposit", amountMinor: 1000, dueAt: "2026-08-01", paidAt: 123 },
          { id: "p2", label: "Undated", amountMinor: 1000, dueAt: null, paidAt: null },
        ],
        tasks: [
          { id: "t1", title: "Done task", dueAt: "2026-08-01", status: "done" },
          { id: "t2", title: "Undated task", dueAt: null, status: "open" },
        ],
      }),
    );
    expect(a).toEqual([]);
  });

  it("surfaces overdue payments/tasks first, oldest overdue at the top", () => {
    const a = buildAgenda(
      input({
        payments: [
          { id: "p1", label: "Overdue newer", amountMinor: 1, dueAt: "2026-07-10", paidAt: null },
          { id: "p2", label: "Overdue older", amountMinor: 1, dueAt: "2026-07-01", paidAt: null },
        ],
        tasks: [{ id: "t1", title: "Upcoming", dueAt: "2026-07-20", status: "open" }],
      }),
    );
    expect(a.map((i) => i.label)).toEqual(["Overdue older", "Overdue newer", "Upcoming"]);
    expect(a.map((i) => i.overdue)).toEqual([true, true, false]);
  });

  it("respects horizonDays (drops far-future upcoming) but keeps all overdue", () => {
    const a = buildAgenda(
      input({
        horizonDays: 30,
        payments: [
          { id: "p1", label: "Far future", amountMinor: 1, dueAt: "2026-12-01", paidAt: null },
          { id: "p2", label: "Overdue", amountMinor: 1, dueAt: "2026-06-01", paidAt: null },
        ],
      }),
    );
    expect(a.map((i) => i.label)).toEqual(["Overdue"]);
  });

  it("caps upcoming at limit but never caps overdue", () => {
    const a = buildAgenda(
      input({
        limit: 2,
        payments: [
          { id: "o1", label: "OD1", amountMinor: 1, dueAt: "2026-06-01", paidAt: null },
          { id: "o2", label: "OD2", amountMinor: 1, dueAt: "2026-06-02", paidAt: null },
          { id: "u1", label: "U1", amountMinor: 1, dueAt: "2026-07-20", paidAt: null },
          { id: "u2", label: "U2", amountMinor: 1, dueAt: "2026-07-21", paidAt: null },
          { id: "u3", label: "U3", amountMinor: 1, dueAt: "2026-07-22", paidAt: null },
        ],
      }),
    );
    // Both overdue kept + only 2 upcoming.
    expect(a.map((i) => i.label)).toEqual(["OD1", "OD2", "U1", "U2"]);
  });

  it("breaks same-date ties by kind (event<payment<task) then label", () => {
    const day = "2026-08-05";
    const a = buildAgenda(
      input({
        events: [{ id: "e1", name: "Zeta event", startAt: new Date(2026, 7, 5, 10).toISOString() }],
        payments: [{ id: "p1", label: "Alpha payment", amountMinor: 1, dueAt: day, paidAt: null }],
        tasks: [{ id: "t1", title: "Beta task", dueAt: day, status: "open" }],
      }),
    );
    expect(a.map((i) => i.kind)).toEqual(["event", "payment", "task"]);
  });

  it("returns [] for empty input", () => {
    expect(buildAgenda(input({}))).toEqual([]);
  });

  it("includes items dated exactly today (not excluded as past) and not overdue", () => {
    const a = buildAgenda(
      input({
        tasks: [{ id: "t1", title: "Today task", dueAt: "2026-07-16", status: "open" }],
      }),
    );
    expect(a.map((i) => i.label)).toEqual(["Today task"]);
    expect(a[0]!.overdue).toBe(false);
  });
});
