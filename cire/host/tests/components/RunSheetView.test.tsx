// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import RunSheetView, { type RunSheetViewProps } from "../../src/components/RunSheetView";
import { MembersChangedContext } from "../../src/lib/members-changed";
import { COMING_UP_MS } from "../../src/lib/run-sheet";
import {
  __resetRunSheetCache,
  type RunSheet,
  type RunSheetEventItem,
  type RunSheetTaskItem,
} from "../../src/lib/run-sheet-store";
import { TasksChangedContext } from "../../src/lib/tasks-changed";
import { __resetTasksCache } from "../../src/lib/tasks-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

/**
 * The run sheet (`cire/host/src/components/RunSheetView.tsx`). The labels,
 * texts and data attributes named here are the contract the E2E flow also
 * relies on.
 *
 * The unit runner's zone is Australia/Sydney, so a time shown in Sydney time
 * proves nothing on its own: the Kolkata row is the one that shows the view
 * reads each row's own zone rather than the browser's.
 *
 *  1. Below Gold: the neutral message, no upgrade wording, no request.
 *  2. A 402: the same neutral message.
 *  3. Any other refusal: a quiet error, and no navigation.
 *  4. Rows grouped by date in each row's zone, untimed last, times in the
 *     row's zone.
 *  5. `own` scope: "Your tasks for the day".
 *  6. "You": visible text and `data-own` on the reader's rows only.
 *  7. Done tasks: "Done", struck through, never coming up.
 *  8. "Coming up": from 30 minutes before, on a timer, without a re-read, and
 *     again on tab wake.
 *  9. "Event removed".
 * 10. A linked task says how far from its event.
 * 11. Holders' names in text, the reader first.
 * 12. A re-read on `tasks-changed` and on `members-changed`.
 * 13. Empty states, by scope and role.
 * 14. A way to the checklist for owners and editors only.
 *
 * Added to kill what mutation testing found unpinned (testing-patterns
 * §Mutation testing), each a thing the reader sees:
 * 15. The zone, once for a day on one clock, on every row for a day on two;
 *     the year on a day that is not this year's.
 * 16. A time on a clock this browser does not know, read as stored.
 * 17. An event's place, and an end past midnight naming its day.
 * 18. A linked task's distance in hours, and at the start; none for an event
 *     the reader cannot see.
 * 19. A 401 sends the reader to sign in; Try again reads again.
 * 20. Every stack is read-only, and an open task nobody holds says so.
 *
 * An event's run of show (#1661's items, on the event's own clock):
 * 21. In the order the guest's sheet reads it — from the event's start, an
 *     item earlier on the clock than the start last and marked — reckoned on
 *     the event's zone, not the browser's, and each time as written.
 * 22. Inside its event's band: not a run-sheet row, nothing to press or type
 *     in, never "Coming up".
 * 23. An event with no run of show shows no list.
 * 24. A holder OSN gave no name: a face, counted, never named; one the
 *     answer carries no seat for: left out.
 * 25. A first flag weeks away: one timer of the longest wait a browser keeps,
 *     never a loop of timers that fire at once.
 */

const ARRIVAL = Date.parse("2099-06-20T14:30:00+10:00");

const task = (over: Partial<RunSheetTaskItem> & { id: string }): RunSheetTaskItem => ({
  kind: "task",
  title: over.id,
  notes: null,
  status: "open",
  runAt: null,
  runTimezone: null,
  eventId: null,
  runOffsetMinutes: null,
  anchored: false,
  eventRemoved: false,
  assigneeHostIds: [],
  ...over,
});

const DAY: RunSheet = {
  scope: "full",
  viewerHostId: "whost_me",
  items: [
    task({
      id: "programmes",
      title: "Hand out programmes",
      runAt: "2099-06-20T14:00:00+10:00",
      runTimezone: "Australia/Sydney",
      eventId: "evt_arrival",
      runOffsetMinutes: -30,
      anchored: true,
      assigneeHostIds: ["whost_me"],
    }),
    {
      kind: "event",
      id: "evt_arrival",
      name: "Guest arrival",
      startAt: "2099-06-20T14:30:00+10:00",
      endAt: "2099-06-20T15:00:00+10:00",
      timezone: "Australia/Sydney",
      venueName: "The Hall",
      address: "1 Hall St",
      runOfShow: [],
    },
    task({
      id: "flowers",
      title: "Collect the flowers",
      runAt: "2099-06-20T12:00:00+05:30",
      runTimezone: "Asia/Kolkata",
      assigneeHostIds: ["whost_gus"],
    }),
    task({
      id: "cake",
      title: "Set up the cake table",
      runAt: "2099-06-20T17:00:00+10:00",
      runTimezone: "Australia/Sydney",
      eventRemoved: true,
    }),
    task({ id: "kit", title: "Pack the emergency kit", status: "done" }),
  ],
  people: [
    { hostId: "whost_me", displayName: "Me Myself" },
    { hostId: "whost_gus", handle: "gus" },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function view(props: Partial<RunSheetViewProps> = {}) {
  const [tasksChanged, setTasksChanged] = createSignal(0);
  const [membersChanged, setMembersChanged] = createSignal(0);
  const onOpenChecklist = vi.fn();
  render(() => (
    <MembersChangedContext.Provider value={membersChanged}>
      <TasksChangedContext.Provider value={tasksChanged}>
        <RunSheetView
          weddingId="wed_1"
          tier="gold"
          callerRole="owner"
          canEdit
          onOpenChecklist={onOpenChecklist}
          {...props}
        />
      </TasksChangedContext.Provider>
    </MembersChangedContext.Provider>
  ));
  return {
    onOpenChecklist,
    tasksChanged: () => setTasksChanged((n) => n + 1),
    membersChanged: () => setMembersChanged((n) => n + 1),
  };
}

const rowOf = (id: string) =>
  document.querySelector(`[data-run-sheet-item="${id}"]`) as HTMLElement | null;
const runSheetReads = () =>
  authFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/run-sheet")).length;

beforeEach(() => {
  __resetWeddingScope();
  __resetTasksCache();
  __resetRunSheetCache();
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  vi.useRealTimers();
});

describe("RunSheetView", () => {
  it("says the run sheet is not available below Gold, offers nothing to buy, and asks for nothing", () => {
    view({ tier: "ivory", callerRole: "helper", canEdit: false, onOpenChecklist: undefined });
    expect(screen.getByText("The run sheet isn't available for this wedding.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/upgrade|gold/i);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("says the same when the API answers 402", async () => {
    authFetchMock.mockResolvedValue(json({ error: "payment_required", tier: "gold" }, 402));
    view({ callerRole: "helper", canEdit: false, onOpenChecklist: undefined });
    await waitFor(() =>
      expect(screen.getByText("The run sheet isn't available for this wedding.")).toBeTruthy(),
    );
  });

  it.each([403, 404, 500])("shows a quiet error on %i, and goes nowhere", async (status) => {
    authFetchMock.mockResolvedValue(json({ error: "x" }, status));
    view();
    await waitFor(() => expect(screen.getByText("Couldn't load the run sheet.")).toBeTruthy());
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("groups the day by date in each row's zone, with untimed tasks last", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    const ids = [...document.querySelectorAll("[data-run-sheet-item]")].map(
      (el) => (el as HTMLElement).dataset.runSheetItem,
    );
    expect(ids).toEqual(["programmes", "evt_arrival", "flowers", "cake", "kit"]);
    // Headed lists: the day, then "Any time on the day".
    const headings = screen.getAllByRole("heading").map((h) => h.textContent ?? "");
    expect(headings.some((h) => /20 June|Saturday/i.test(h))).toBe(true);
    expect(headings.at(-1)).toMatch(/Any time on the day/i);
    expect(within(rowOf("kit")!).queryByRole("time")).toBeNull();
  });

  it("shows each time on its own row's clock, never the browser's", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("flowers")).toBeTruthy());
    // Noon in Kolkata is 4:30 pm in Sydney, the runner's zone.
    expect(rowOf("flowers")!.textContent).toMatch(/12:00\s?pm/i);
    expect(rowOf("flowers")!.textContent).not.toMatch(/4:30\s?pm/i);
    expect(rowOf("programmes")!.textContent).toMatch(/2:00\s?pm/i);
    const time = within(rowOf("programmes")!).getByRole("time") as HTMLTimeElement;
    expect(time.dateTime).toBe("2099-06-20T14:00:00+10:00");
  });

  it("says when the reader sees only their own tasks", async () => {
    authFetchMock.mockResolvedValue(json({ ...DAY, scope: "own" }));
    view({ callerRole: "helper", canEdit: false, onOpenChecklist: undefined });
    await waitFor(() => expect(screen.getByText("Your tasks for the day")).toBeTruthy());
  });

  it("marks the reader's own tasks with a visible You, and no one else's", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    expect(rowOf("programmes")!.hasAttribute("data-own")).toBe(true);
    expect(within(rowOf("programmes")!).getByText("You")).toBeTruthy();
    for (const id of ["flowers", "cake", "kit", "evt_arrival"]) {
      expect(rowOf(id)!.hasAttribute("data-own")).toBe(false);
      expect(within(rowOf(id)!).queryByText("You")).toBeNull();
    }
  });

  it("strikes a done task through and says so, in its slot", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("kit")).toBeTruthy());
    expect(within(rowOf("kit")!).getByText("Done")).toBeTruthy();
    expect(rowOf("kit")!.querySelector("s, del, [class*='line-through']")).toBeTruthy();
  });

  it("flags a task coming up from thirty minutes before it, on a timer, with no re-read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // 40 minutes before the programmes go out at 14:00.
    vi.setSystemTime(ARRIVAL - 30 * 60_000 - 40 * 60_000);
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await vi.waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    expect(rowOf("programmes")!.hasAttribute("data-coming-up")).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(rowOf("programmes")!.hasAttribute("data-coming-up")).toBe(true);
    expect(within(rowOf("programmes")!).getByText("Coming up")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(COMING_UP_MS);
    expect(rowOf("programmes")!.hasAttribute("data-coming-up")).toBe(false);
    expect(runSheetReads()).toBe(1);
  });

  it("waits at most 2^31 − 1 ms for a flag weeks away: one timer, never a loop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Sixty days before the day: further off than a browser timer can wait,
    // which it would read as no wait at all.
    vi.setSystemTime(ARRIVAL - 60 * 24 * 60 * 60_000);
    const timers = vi.spyOn(globalThis, "setTimeout");
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await vi.waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    await vi.advanceTimersByTimeAsync(1_000);
    const longWaits = timers.mock.calls.map(([, ms]) => ms ?? 0).filter((ms) => ms > 60_000);
    expect(longWaits).toEqual([2 ** 31 - 1]);
    expect(rowOf("programmes")!.hasAttribute("data-coming-up")).toBe(false);
    expect(runSheetReads()).toBe(1);
  });

  it("looks at the clock again when the tab wakes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ARRIVAL - 3 * 60 * 60_000);
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    expect(rowOf("programmes")!.hasAttribute("data-coming-up")).toBe(false);
    // The tab slept through the timer.
    vi.setSystemTime(ARRIVAL - 30 * 60_000 - 5 * 60_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(rowOf("programmes")!.hasAttribute("data-coming-up")).toBe(true));
  });

  it("never flags a done task", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2099-06-20T13:50:00+10:00"));
    authFetchMock.mockResolvedValue(
      json({
        ...DAY,
        items: [task({ id: "done", status: "done", runAt: "2099-06-20T14:00:00+10:00" })],
      }),
    );
    view();
    await waitFor(() => expect(rowOf("done")).toBeTruthy());
    expect(rowOf("done")!.hasAttribute("data-coming-up")).toBe(false);
  });

  it("says when a task's event was removed", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("cake")).toBeTruthy());
    expect(within(rowOf("cake")!).getByText("Event removed")).toBeTruthy();
  });

  it("says how far a linked task is from its event", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    expect(rowOf("programmes")!.textContent).toMatch(/30 min before Guest arrival/);
  });

  it("names the people holding a task in text, the reader first", async () => {
    authFetchMock.mockResolvedValue(
      json({
        ...DAY,
        items: [
          task({
            id: "rings",
            title: "Mind the rings",
            runAt: "2099-06-20T14:30:00+10:00",
            assigneeHostIds: ["whost_gus", "whost_me"],
          }),
        ],
      }),
    );
    view();
    await waitFor(() => expect(rowOf("rings")).toBeTruthy());
    expect(rowOf("rings")!.textContent).toMatch(/Me Myself.*@gus/);
  });

  it("draws a holder OSN gave no name as a face, and counts them rather than naming them", async () => {
    authFetchMock.mockResolvedValue(
      json({
        ...DAY,
        items: [
          task({
            id: "rings",
            title: "Mind the rings",
            runAt: "2099-06-20T14:30:00+10:00",
            assigneeHostIds: ["whost_me", "whost_nameless"],
          }),
        ],
        people: [...DAY.people, { hostId: "whost_nameless" }],
      }),
    );
    view();
    await waitFor(() => expect(rowOf("rings")).toBeTruthy());
    expect(rowOf("rings")!.querySelectorAll("[data-holder]")).toHaveLength(2);
    expect(rowOf("rings")!.querySelector('[data-holder="whost_nameless"]')).toBeTruthy();
    expect(rowOf("rings")!.textContent).toContain("Held by 2 people");
    expect(rowOf("rings")!.textContent).not.toContain("whost_nameless");
  });

  it("leaves out a holder the answer carries no seat for", async () => {
    authFetchMock.mockResolvedValue(
      json({
        ...DAY,
        items: [
          task({
            id: "rings",
            title: "Mind the rings",
            runAt: "2099-06-20T14:30:00+10:00",
            assigneeHostIds: ["whost_me", "whost_gone"],
          }),
        ],
      }),
    );
    view();
    await waitFor(() => expect(rowOf("rings")).toBeTruthy());
    expect(rowOf("rings")!.querySelectorAll("[data-holder]")).toHaveLength(1);
    expect(rowOf("rings")!.textContent).toContain("Held by Me Myself");
  });

  it("reads the run sheet again when the tasks or the seats change", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    const signals = view();
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    expect(runSheetReads()).toBe(1);
    signals.tasksChanged();
    await waitFor(() => expect(runSheetReads()).toBe(2));
    signals.membersChanged();
    await waitFor(() => expect(runSheetReads()).toBe(3));
  });

  it("offers an owner or editor the checklist from an empty run sheet", async () => {
    authFetchMock.mockResolvedValue(json({ ...DAY, items: [], people: [] }));
    const { onOpenChecklist } = view();
    await waitFor(() => expect(screen.getByText("Nothing is timed for the day yet.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Set times on the checklist" }));
    expect(onOpenChecklist).toHaveBeenCalledTimes(1);
  });

  it("tells a helper with nothing of theirs so, and offers no checklist", async () => {
    authFetchMock.mockResolvedValue(json({ ...DAY, scope: "own", items: [], people: [] }));
    view({ callerRole: "helper", canEdit: false, onOpenChecklist: undefined });
    await waitFor(() =>
      expect(screen.getByText("Nothing on the run sheet is yours yet.")).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /checklist/i })).toBeNull();
  });

  it("offers owners and editors a way to change times, and no one else", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    const { onOpenChecklist } = view();
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Change times on the checklist" }));
    expect(onOpenChecklist).toHaveBeenCalledTimes(1);
    cleanup();

    authFetchMock.mockResolvedValue(json(DAY));
    __resetRunSheetCache();
    view({ callerRole: "viewer", canEdit: false, onOpenChecklist: undefined });
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /checklist/i })).toBeNull();
  });

  it("names the zone once for a day on one clock, and on every row for a day on two", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("flowers")).toBeTruthy());
    // The fixture's day is in 2099, not this year: the heading says so.
    expect(screen.getByRole("heading", { name: "Saturday 20 June 2099" })).toBeTruthy();
    expect(screen.getByText("Each time on its own clock")).toBeTruthy();
    expect(rowOf("flowers")!.textContent).toContain("GMT+5:30");
    expect(rowOf("programmes")!.textContent).toContain("AEST");
    cleanup();

    __resetRunSheetCache();
    authFetchMock.mockResolvedValue(
      json({ ...DAY, items: DAY.items.filter((item) => item.id !== "flowers") }),
    );
    view();
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    expect(screen.getByText("Times in AEST")).toBeTruthy();
    expect(screen.queryByText("Each time on its own clock")).toBeNull();
    expect(rowOf("programmes")!.textContent).not.toContain("AEST");
  });

  it("reads a time on a clock this browser does not know as it was stored", async () => {
    const mars = (id: string, runAt: string) =>
      task({ id, runAt, runTimezone: "Mars/Olympus", assigneeHostIds: [] });
    authFetchMock.mockResolvedValue(
      json({
        ...DAY,
        items: [
          mars("dawn", "2099-06-20T00:15:00+10:00"),
          mars("noon", "2099-06-20T12:00:00+10:00"),
          task({ id: "tea", runAt: "2099-06-20T15:30:00+10:00", runTimezone: "Australia/Sydney" }),
        ],
      }),
    );
    view();
    await waitFor(() => expect(rowOf("dawn")).toBeTruthy());
    expect(rowOf("dawn")!.textContent).toMatch(/12:15\s?am/);
    expect(rowOf("noon")!.textContent).toMatch(/12:00\s?pm/);
    // Two clocks on the day, so each row names its own.
    expect(rowOf("noon")!.textContent).toContain("Mars/Olympus");
    expect(rowOf("tea")!.textContent).toMatch(/3:30\s?pm/);
  });

  it("gives an event its place, and names the day an end past midnight falls on", async () => {
    const at = (id: string, over: Partial<RunSheetEventItem>): RunSheetEventItem => ({
      kind: "event",
      id,
      name: id,
      startAt: "2099-06-20T18:00:00+10:00",
      endAt: "",
      timezone: "Australia/Sydney",
      venueName: null,
      address: null,
      runOfShow: [],
      ...over,
    });
    authFetchMock.mockResolvedValue(
      json({
        ...DAY,
        items: [
          at("party", {
            endAt: "2099-06-21T00:30:00+10:00",
            venueName: "The Hall",
            address: "1 Hall St",
          }),
          at("toast", {
            startAt: "2099-06-20T19:00:00+10:00",
            endAt: "2099-06-20T19:15:00+10:00",
            address: "2 Hall St",
          }),
          at("drinks", { startAt: "2099-06-20T20:00:00+10:00" }),
        ],
        people: [],
      }),
    );
    view();
    await waitFor(() => expect(rowOf("party")).toBeTruthy());
    expect(rowOf("party")!.textContent).toMatch(/to 12:30\s?am Sun/);
    expect(rowOf("party")!.textContent).toContain("The Hall · 1 Hall St");
    expect(rowOf("toast")!.textContent).toMatch(/to 7:15\s?pm/);
    expect(rowOf("toast")!.textContent).not.toMatch(/Sat|Sun|·/);
    expect(rowOf("toast")!.textContent).toContain("2 Hall St");
    expect(rowOf("drinks")!.textContent).not.toMatch(/to /);
  });

  it("says how far a linked task is from its event in hours too, and at its start", async () => {
    const linked = (id: string, runOffsetMinutes: number, over: Partial<RunSheetTaskItem> = {}) =>
      task({
        id,
        runAt: "2099-06-20T14:30:00+10:00",
        runTimezone: "Australia/Sydney",
        eventId: "evt_arrival",
        runOffsetMinutes,
        anchored: true,
        ...over,
      });
    authFetchMock.mockResolvedValue(
      json({
        ...DAY,
        items: [
          DAY.items[1]!,
          linked("start", 0),
          linked("later", 90),
          linked("hour", -60),
          linked("unseen", 30, { eventId: "evt_hidden" }),
          linked("loose", 30, { anchored: false }),
        ],
      }),
    );
    view();
    await waitFor(() => expect(rowOf("start")).toBeTruthy());
    expect(rowOf("start")!.textContent).toContain("At the start of Guest arrival");
    expect(rowOf("later")!.textContent).toContain("1 hr 30 min after Guest arrival");
    expect(rowOf("hour")!.textContent).toContain("1 hr before Guest arrival");
    // An event the reader is not given, or a link that no longer holds the
    // time: no distance to say.
    expect(rowOf("unseen")!.textContent).not.toMatch(/before|after/);
    expect(rowOf("loose")!.textContent).not.toMatch(/before|after/);
  });

  it("sends a reader whose session ended to sign in", async () => {
    authFetchMock.mockResolvedValue(json({ error: "unauthorized" }, 401));
    view();
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });

  it("reads again when asked to after a failure", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "x" }, 500));
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rowOf("programmes")).toBeTruthy());
    expect(runSheetReads()).toBe(2);
    expect(screen.queryByText("Couldn't load the run sheet.")).toBeNull();
  });

  it("shows who holds each task without a way to change it, and an open task nobody holds", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("cake")).toBeTruthy());
    expect(screen.queryAllByRole("button", { name: /^Assign people/ })).toHaveLength(0);
    expect(within(rowOf("cake")!).getByRole("img", { name: "Nobody assigned yet" })).toBeTruthy();
    expect(within(rowOf("kit")!).queryByRole("img", { name: "Nobody assigned yet" })).toBeNull();
  });
  /** A Kolkata reception at 18:00 (22:30 in Sydney, the runner's zone) whose
   *  run of show is stored in the organiser's order, not the clock's. */
  const RECEPTION: RunSheetEventItem = {
    kind: "event",
    id: "evt_reception",
    name: "Reception",
    startAt: "2099-06-20T18:00:00+05:30",
    endAt: "",
    timezone: "Asia/Kolkata",
    venueName: null,
    address: null,
    runOfShow: [
      { time: "17:30", label: "Doors close" },
      { time: "23:30", label: "Sparklers" },
      { time: "00:30", label: "Last bus" },
      { time: "19:00", label: "Dinner" },
    ],
  };
  const runOfShowLines = (id: string) =>
    [...(rowOf(id)?.querySelectorAll("[data-run-of-show-item]") ?? [])].map((el) =>
      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    );

  it("reads an event's run of show from its start on the event's own clock, after midnight last and marked", async () => {
    authFetchMock.mockResolvedValue(json({ ...DAY, items: [RECEPTION], people: [] }));
    view();
    await waitFor(() => expect(rowOf("evt_reception")).toBeTruthy());
    expect(runOfShowLines("evt_reception")).toEqual([
      "7:00 pm Dinner",
      "11:30 pm Sparklers",
      "12:30 am Last bus (after midnight)",
      "5:30 pm Doors close (after midnight)",
    ]);
    const times = [...rowOf("evt_reception")!.querySelectorAll("[data-run-of-show-item] time")].map(
      (t) => (t as HTMLTimeElement).dateTime,
    );
    expect(times).toEqual(["19:00", "23:30", "00:30", "17:30"]);
    expect(
      within(rowOf("evt_reception")!).getByRole("list", { name: "Run of show for Reception" }),
    ).toBeTruthy();
  });

  it("keeps the run of show inside its event: no row of its own, nothing to press, never coming up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Ten minutes before Dinner (19:00 Kolkata).
    vi.setSystemTime(Date.parse("2099-06-20T18:50:00+05:30"));
    authFetchMock.mockResolvedValue(json({ ...DAY, items: [RECEPTION], people: [] }));
    view();
    await waitFor(() => expect(rowOf("evt_reception")).toBeTruthy());
    expect(
      [...document.querySelectorAll("[data-run-sheet-item]")].map(
        (el) => (el as HTMLElement).dataset.runSheetItem,
      ),
    ).toEqual(["evt_reception"]);
    const list = within(rowOf("evt_reception")!).getByRole("list", {
      name: "Run of show for Reception",
    });
    expect(list.querySelectorAll("[data-run-of-show-item]")).toHaveLength(4);
    expect(list.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    expect(list.querySelector("[data-run-sheet-item], [data-kind], [data-coming-up]")).toBeNull();
    expect(document.body.textContent).not.toContain("Coming up");
  });

  it("shows no run of show for an event with none", async () => {
    authFetchMock.mockResolvedValue(json(DAY));
    view();
    await waitFor(() => expect(rowOf("evt_arrival")).toBeTruthy());
    expect(within(rowOf("evt_arrival")!).queryByRole("list")).toBeNull();
    expect(rowOf("evt_arrival")!.querySelector("[data-run-of-show-item]")).toBeNull();
  });
});
