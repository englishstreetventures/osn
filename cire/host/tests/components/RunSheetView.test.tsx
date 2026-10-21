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
  type RunSheetTaskItem,
} from "../../src/lib/run-sheet-store";
import { TasksChangedContext } from "../../src/lib/tasks-changed";
import { __resetTasksCache } from "../../src/lib/tasks-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

/**
 * The run sheet, as the designer builds it (`cire/host/src/components/
 * RunSheetView.tsx`; the UI brief is in the branch plan). SKIPPED until the
 * designed view replaces the placeholder: set `DESIGNED` and every case here
 * must pass. The labels, texts and data attributes named here are the
 * contract the E2E flow also relies on.
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
    { hostId: "whost_me", osnProfileId: "usr_me", displayName: "Me Myself" },
    { hostId: "whost_gus", osnProfileId: "usr_gus", handle: "gus" },
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

/** `true` once the designed view replaces the placeholder: then every case
 *  below runs, and must pass. */
const DESIGNED = true;

describe.skipIf(!DESIGNED)("RunSheetView", () => {
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
});
