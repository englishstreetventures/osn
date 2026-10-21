import { describe, expect, it } from "bun:test";

import {
  orderRunSheet,
  type RunSheetEventRow,
  type RunSheetTaskRow,
} from "../../src/lib/run-sheet";

/**
 * The run sheet's order is by INSTANT, across zones: a Kolkata task at noon
 * IST (06:30 UTC) runs between a Sydney ceremony at 15:00 AEST (05:00 UTC) and
 * a Sydney reception at 18:00 AEST (08:00 UTC), though its text sorts first.
 * Every tie has one answer, so two reads of one day never shuffle.
 */

const event = (over: Partial<RunSheetEventRow> & { id: string }): RunSheetEventRow => ({
  name: over.id,
  startAt: "2099-06-20T15:00:00+10:00",
  endAt: "",
  timezone: "Australia/Sydney",
  venueName: null,
  address: null,
  sortOrder: 0,
  ...over,
});

const task = (over: Partial<RunSheetTaskRow> & { id: string }): RunSheetTaskRow => ({
  title: over.id,
  notes: null,
  status: "open",
  sortOrder: 0,
  runAt: null,
  runTimezone: null,
  eventId: null,
  runOffsetMinutes: null,
  anchored: false,
  eventRemoved: false,
  assigneeHostIds: [],
  ...over,
});

const ids = (events: RunSheetEventRow[], tasks: RunSheetTaskRow[]) =>
  orderRunSheet(events, tasks).map((item) => item.id);

describe("orderRunSheet", () => {
  it("orders by instant across zones, not by the text of the time", () => {
    expect(
      ids(
        [
          event({ id: "ceremony", startAt: "2099-06-20T15:00:00+10:00" }),
          event({ id: "reception", startAt: "2099-06-20T18:00:00+10:00" }),
        ],
        [
          task({
            id: "flowers",
            runAt: "2099-06-20T12:00:00+05:30",
            runTimezone: "Asia/Kolkata",
          }),
        ],
      ),
    ).toEqual(["ceremony", "flowers", "reception"]);
  });

  it("puts an event before a task at the same instant", () => {
    expect(
      ids(
        [event({ id: "ceremony", startAt: "2099-06-20T15:00:00+10:00" })],
        // The same instant, written in another zone.
        [task({ id: "rings", runAt: "2099-06-20T10:30:00+05:30", sortOrder: -5 })],
      ),
    ).toEqual(["ceremony", "rings"]);
  });

  it("puts a task linked to one event that lands on another's start after that event", () => {
    expect(
      ids(
        [
          event({ id: "ceremony", startAt: "2099-06-20T15:00:00+10:00", sortOrder: 0 }),
          event({ id: "drinks", startAt: "2099-06-20T16:00:00+10:00", sortOrder: 1 }),
        ],
        [
          task({
            id: "photos",
            runAt: "2099-06-20T16:00:00+10:00",
            eventId: "ceremony",
            runOffsetMinutes: 60,
            anchored: true,
          }),
        ],
      ),
    ).toEqual(["ceremony", "drinks", "photos"]);
  });

  it("orders two tasks at one instant by their checklist order, then by id", () => {
    const at = "2099-06-20T14:00:00+10:00";
    expect(
      ids(
        [],
        [
          task({ id: "b", runAt: at, sortOrder: 1 }),
          task({ id: "c", runAt: at, sortOrder: 0 }),
          task({ id: "a", runAt: at, sortOrder: 1 }),
        ],
      ),
    ).toEqual(["c", "a", "b"]);
  });

  it("orders two events at one instant by their schedule order, then by id", () => {
    expect(
      ids(
        [
          event({ id: "y", sortOrder: 2 }),
          event({ id: "z", sortOrder: 1 }),
          event({ id: "x", sortOrder: 2 }),
        ],
        [],
      ),
    ).toEqual(["z", "x", "y"]);
  });

  it("puts anything whose time cannot be read after every timed item, by id", () => {
    expect(
      ids(
        [event({ id: "tbc", startAt: "TBC" }), event({ id: "ceremony" })],
        [
          task({ id: "garbled", runAt: "half past" }),
          task({ id: "late", runAt: "2099-12-31T23:00:00+11:00" }),
        ],
      ),
    ).toEqual(["ceremony", "late", "garbled", "tbc"]);
  });

  it("puts untimed tasks last, by their checklist order, then by id", () => {
    expect(
      ids(
        [event({ id: "tbc", startAt: "TBC" })],
        [
          task({ id: "kit", sortOrder: 2 }),
          task({ id: "rings", sortOrder: 0 }),
          task({ id: "aaa", sortOrder: 2 }),
          task({ id: "timed", runAt: "2099-06-20T09:00:00+10:00" }),
        ],
      ),
    ).toEqual(["timed", "tbc", "rings", "aaa", "kit"]);
  });

  it("answers each item with its kind and exactly the fields a reader is given", () => {
    const [ceremony, rings] = orderRunSheet(
      [event({ id: "ceremony", venueName: "The Hall", address: "1 Hall St", sortOrder: 4 })],
      [
        task({
          id: "rings",
          title: "Bring the rings",
          notes: "Blue box",
          runAt: "2099-06-20T15:30:00+10:00",
          runTimezone: "Australia/Sydney",
          eventId: "ceremony",
          runOffsetMinutes: 30,
          anchored: true,
          assigneeHostIds: ["whost_1"],
          sortOrder: 7,
        }),
      ],
    );
    expect(ceremony).toEqual({
      kind: "event",
      id: "ceremony",
      name: "ceremony",
      startAt: "2099-06-20T15:00:00+10:00",
      endAt: "",
      timezone: "Australia/Sydney",
      venueName: "The Hall",
      address: "1 Hall St",
    });
    expect(rings).toEqual({
      kind: "task",
      id: "rings",
      title: "Bring the rings",
      notes: "Blue box",
      status: "open",
      runAt: "2099-06-20T15:30:00+10:00",
      runTimezone: "Australia/Sydney",
      eventId: "ceremony",
      runOffsetMinutes: 30,
      anchored: true,
      eventRemoved: false,
      assigneeHostIds: ["whost_1"],
    });
  });
});
