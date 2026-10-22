import { describe, expect, it } from "vitest";

import { COMING_UP_MS, isComingUp, isOwnTask, nextComingUpChange } from "../../src/lib/run-sheet";
import type { RunSheetItem, RunSheetTaskItem } from "../../src/lib/run-sheet-store";

/**
 * "Coming up" is decided in the browser against its own clock: a task is
 * flagged from 30 minutes before it starts until it starts, done tasks never.
 * The view re-evaluates at `nextComingUpChange` and on tab wake, so these pin
 * exactly where the flag flips.
 */

const START = Date.parse("2099-06-20T15:00:00+10:00");

const task = (over: Partial<RunSheetTaskItem> = {}): RunSheetTaskItem => ({
  kind: "task",
  id: "t",
  title: "T",
  notes: null,
  status: "open",
  runAt: "2099-06-20T15:00:00+10:00",
  runTimezone: "Australia/Sydney",
  eventId: null,
  runOffsetMinutes: null,
  anchored: false,
  eventRemoved: false,
  assigneeHostIds: [],
  ...over,
});

const event: RunSheetItem = {
  kind: "event",
  id: "e",
  name: "Ceremony",
  startAt: "2099-06-20T14:50:00+10:00",
  endAt: "",
  timezone: "Australia/Sydney",
  venueName: null,
  address: null,
  runOfShow: [],
};

describe("isComingUp", () => {
  it("flags an open task from thirty minutes before it starts until it starts", () => {
    expect(COMING_UP_MS).toBe(30 * 60_000);
    expect(isComingUp(task(), START - COMING_UP_MS - 1)).toBe(false);
    expect(isComingUp(task(), START - COMING_UP_MS)).toBe(true);
    expect(isComingUp(task(), START - 1)).toBe(true);
    expect(isComingUp(task(), START)).toBe(false);
    expect(isComingUp(task(), START + 60_000)).toBe(false);
  });

  it("never flags a done task, an untimed one, one whose time cannot be read, or an event", () => {
    const now = START - 60_000;
    expect(isComingUp(task({ status: "done" }), now)).toBe(false);
    expect(isComingUp(task({ runAt: null }), now)).toBe(false);
    expect(isComingUp(task({ runAt: "soon" }), now)).toBe(false);
    expect(isComingUp(event, Date.parse(event.startAt) - 60_000)).toBe(false);
  });
});

describe("nextComingUpChange", () => {
  it("is the next instant a flag goes on or off", () => {
    const items = [task(), task({ id: "later", runAt: "2099-06-20T17:00:00+10:00" })];
    expect(nextComingUpChange(items, START - 2 * COMING_UP_MS)).toBe(START - COMING_UP_MS);
    expect(nextComingUpChange(items, START - COMING_UP_MS)).toBe(START);
    expect(nextComingUpChange(items, START)).toBe(
      Date.parse("2099-06-20T17:00:00+10:00") - COMING_UP_MS,
    );
  });

  it("is the earliest change whatever order the rows come in", () => {
    const items = [task({ id: "later", runAt: "2099-06-20T17:00:00+10:00" }), task()];
    expect(nextComingUpChange(items, START - 2 * COMING_UP_MS)).toBe(START - COMING_UP_MS);
  });

  it("is null when no flag will change again", () => {
    expect(
      nextComingUpChange([task({ status: "done" }), event, task({ runAt: null })], 0),
    ).toBeNull();
    expect(nextComingUpChange([task()], START)).toBeNull();
  });
});

describe("isOwnTask", () => {
  it("is a task the reader's seat holds, shared or not", () => {
    expect(isOwnTask(task({ assigneeHostIds: ["whost_me"] }), "whost_me")).toBe(true);
    expect(isOwnTask(task({ assigneeHostIds: ["whost_gus", "whost_me"] }), "whost_me")).toBe(true);
    expect(isOwnTask(task({ assigneeHostIds: ["whost_gus"] }), "whost_me")).toBe(false);
    expect(isOwnTask(task({ assigneeHostIds: ["whost_me"] }), null)).toBe(false);
    expect(isOwnTask(event, "whost_me")).toBe(false);
  });
});
