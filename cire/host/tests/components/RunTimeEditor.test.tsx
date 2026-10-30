// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});
// The real clock reader, counted: how often the rows read an event's start.
vi.mock("../../src/lib/run-sheet-display", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/run-sheet-display")>();
  return { ...actual, zonedTime: vi.fn(actual.zonedTime) };
});

import { For } from "solid-js";

import RunTimeEditor, { type RunTimeEditorProps } from "../../src/components/RunTimeEditor";
import type { EventRow } from "../../src/lib/events-store";
import { zonedTime } from "../../src/lib/run-sheet-display";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../../src/lib/tasks-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

/**
 * The run-time popover on a checklist row
 * (`cire/host/src/components/RunTimeEditor.tsx`). It saves through
 * `saveTaskRunTime` (`lib/run-time-write.ts`), whose own tests cover the
 * write; these cover what the organiser sees and sends.
 *
 *  1. The trigger names the task's time, or offers to set one.
 *  2. Linked, at a clock time: `clock`, and no zone field.
 *  3. Linked, minutes before the start: `offset`, negative.
 *  4. Unlinked: `fixed`, the zone defaulting to the one every event shares.
 *  5. Unlinked on a wedding whose events span zones: the browser's zone.
 *  6. Clear: `null`.
 *  7. An API that ignored the field: says it was not saved.
 *  8. The two 422s, each in words.
 *  9. Focus back on the trigger after a save.
 * 10. A 401: sign in again.
 *
 * Added to kill what mutation testing found unpinned (testing-patterns
 * §Mutation testing), each a thing the organiser sees or sends:
 * 11. A linked task opens on its event, minutes and side, and says where that
 *     lands; minutes after the start go as a positive offset, a day at most.
 * 12. What is missing, said, and nothing sent.
 * 13. The events in the order they start, each with its day and time.
 * 14. A new time starts on the first event's day, and follows a picked
 *     event's day until a date is typed.
 * 15. The zone the events share, not the browser's.
 * 16. The trigger names a zone that is not the reader's, and a removed event.
 * 17. Minutes before the start say where they land; "after" sends a positive
 *     offset, also after a look at the clock-time mode.
 * 18. Cancel closes and sends nothing; Save pressed twice sends once.
 * 19. With the events still loading, or failed, it says so, and names the
 *     task's event as best it can.
 * 20. A fixed time in a zone picked from the list.
 * 21. A checklist of many rows reads no event's start until a popover opens,
 *     and then each start once for every row.
 */

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
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
  runAt: null,
  runTimezone: null,
  eventId: null,
  runOffsetMinutes: null,
  anchored: false,
  eventRemoved: false,
  ...over,
});

const event = (over: Partial<EventRow> & { id: string; name: string }): EventRow =>
  ({
    startAt: "2099-06-20T15:00:00+10:00",
    endAt: "",
    timezone: "Australia/Sydney",
    ...over,
  }) as EventRow;

const SYDNEY_EVENTS = [
  event({ id: "evt_ceremony", name: "Ceremony" }),
  event({ id: "evt_reception", name: "Reception", startAt: "2099-06-20T18:00:00+10:00" }),
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const saved = (over: Partial<TaskRow>) => json({ task: { ...task(), ...over } });

function editor(props: Partial<RunTimeEditorProps> = {}) {
  setCachedTasks("wed_1", [props.task ?? task()]);
  render(() => <RunTimeEditor weddingId="wed_1" task={task()} events={SYDNEY_EVENTS} {...props} />);
}

/** The one PATCH the editor sent, as its body. */
function sentRunTime(): unknown {
  const patch = authFetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patch).toBeTruthy();
  return (JSON.parse(String((patch![1] as RequestInit).body)) as { runTime: unknown }).runTime;
}

const trigger = () => screen.getByRole("button", { name: /time for Bring the rings/i });

beforeEach(() => {
  __resetWeddingScope();
  __resetTasksCache();
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
});

describe("RunTimeEditor", () => {
  it("reads the events' starts only when a popover opens, and once for every row", async () => {
    const rows = ["Bring the rings", "Book the cars", "Pay the band"].map((title, i) =>
      task({ id: `tsk_${i}`, title }),
    );
    setCachedTasks("wed_1", rows);
    // A list of its own, so no earlier case's reading of it counts.
    const events = [...SYDNEY_EVENTS];
    const starts = () =>
      vi.mocked(zonedTime).mock.calls.filter(([at]) => events.some((e) => e.startAt === at)).length;
    vi.mocked(zonedTime).mockClear();
    render(() => (
      <For each={rows}>
        {(row) => <RunTimeEditor weddingId="wed_1" task={row} events={events} />}
      </For>
    ));
    expect(starts()).toBe(0);

    const cars = screen.getByRole("button", { name: /time for Book the cars/i });
    fireEvent.click(cars);
    await screen.findByLabelText("Event");
    expect(starts()).toBe(events.length);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cars.getAttribute("aria-expanded")).toBe("false"));
    const band = screen.getByRole("button", { name: /time for Pay the band/i });
    fireEvent.click(band);
    await waitFor(() => expect(band.getAttribute("aria-expanded")).toBe("true"));
    expect(starts()).toBe(events.length);
  });

  it("names the task's time on its trigger, or offers to set one", () => {
    editor();
    expect(trigger().textContent).toMatch(/Set a time/i);
    cleanup();
    editor({
      task: task({
        runAt: "2099-06-20T14:30:00+10:00",
        runTimezone: "Australia/Sydney",
        eventId: "evt_ceremony",
        runOffsetMinutes: -30,
        anchored: true,
      }),
    });
    expect(trigger().textContent).toMatch(/2:30\s?pm/i);
  });

  it("links to an event at a clock time on the event's clock, with no zone to pick", async () => {
    authFetchMock.mockResolvedValue(saved({ eventId: "evt_ceremony", anchored: true }));
    editor();
    fireEvent.click(trigger());
    fireEvent.change(await screen.findByLabelText("Event"), { target: { value: "evt_ceremony" } });
    expect(screen.queryByLabelText("Time zone")).toBeNull();
    // The two ways to tie the time are one named group, offset first.
    const tie = screen.getByRole("radiogroup", { name: /^How the time follows/ });
    const offset = within(tie).getByRole("radio", { name: "Before or after the start" });
    const clock = within(tie).getByRole("radio", { name: "At a clock time" });
    expect([offset.checked, clock.checked]).toEqual([true, false]);
    expect(offset.name).not.toBe("");
    expect(clock.name).toBe(offset.name);
    fireEvent.click(clock);
    expect([offset.checked, clock.checked]).toEqual([false, true]);
    fireEvent.click(offset);
    expect([offset.checked, clock.checked]).toEqual([true, false]);
    fireEvent.click(screen.getByRole("radio", { name: "At a clock time" }));
    fireEvent.input(screen.getByLabelText("Date"), { target: { value: "2099-06-20" } });
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "14:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sentRunTime()).toEqual({
        kind: "clock",
        eventId: "evt_ceremony",
        at: "2099-06-20T14:30",
      }),
    );
  });

  it("links to an event some minutes before its start", async () => {
    authFetchMock.mockResolvedValue(saved({ eventId: "evt_ceremony", anchored: true }));
    editor();
    fireEvent.click(trigger());
    fireEvent.change(await screen.findByLabelText("Event"), { target: { value: "evt_ceremony" } });
    fireEvent.click(screen.getByRole("radio", { name: "Before or after the start" }));
    fireEvent.input(screen.getByLabelText("Minutes"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Before or after"), { target: { value: "before" } });
    expect(screen.getByText(/^Sat 20 Jun, 2:30\s?pm, on Ceremony's clock$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sentRunTime()).toEqual({
        kind: "offset",
        eventId: "evt_ceremony",
        offsetMinutes: -30,
      }),
    );
  });

  it("sets a fixed time in the zone every event shares, when no event is picked", async () => {
    authFetchMock.mockResolvedValue(saved({ runAt: "2099-06-20T12:00:00+10:00", anchored: false }));
    editor();
    fireEvent.click(trigger());
    expect(((await screen.findByLabelText("Time zone")) as HTMLSelectElement).value).toBe(
      "Australia/Sydney",
    );
    fireEvent.input(screen.getByLabelText("Date"), { target: { value: "2099-06-20" } });
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sentRunTime()).toEqual({
        kind: "fixed",
        at: "2099-06-20T12:00",
        timezone: "Australia/Sydney",
      }),
    );
  });

  it("defaults a fixed time to the browser's zone when the events span more than one", async () => {
    editor({
      events: [
        event({ id: "a", name: "Mehndi", timezone: "Asia/Kolkata" }),
        event({ id: "b", name: "Reception", timezone: "Australia/Sydney" }),
      ],
    });
    fireEvent.click(trigger());
    expect(((await screen.findByLabelText("Time zone")) as HTMLSelectElement).value).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("clears the time", async () => {
    authFetchMock.mockResolvedValue(saved({}));
    editor({
      task: task({ runAt: "2099-06-20T12:00:00+10:00", runTimezone: "Australia/Sydney" }),
    });
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole("button", { name: "Clear time" }));
    await waitFor(() => expect(sentRunTime()).toBeNull());
  });

  it("says the time was not saved when the API answers without one", async () => {
    // An API older than run times answers 200 having ignored the field.
    authFetchMock.mockResolvedValue(json({ task: { id: "tsk_1", title: "Bring the rings" } }));
    editor();
    fireEvent.click(trigger());
    fireEvent.input(await screen.findByLabelText("Date"), { target: { value: "2099-06-20" } });
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText("This time wasn't saved — reload and try again.")).toBeTruthy(),
    );
  });

  it.each([
    ["event_not_in_wedding", "That event is gone — pick another."],
    ["run_time_out_of_range", "Pick a time within a day of the event."],
  ])("says what a 422 %s means", async (error, words) => {
    authFetchMock.mockResolvedValue(json({ error }, 422));
    editor();
    fireEvent.click(trigger());
    fireEvent.change(await screen.findByLabelText("Event"), { target: { value: "evt_ceremony" } });
    fireEvent.click(screen.getByRole("radio", { name: "At a clock time" }));
    fireEvent.input(screen.getByLabelText("Date"), { target: { value: "2099-06-22" } });
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "14:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(words)).toBeTruthy());
  });

  it("puts focus back on the trigger once the time is saved", async () => {
    authFetchMock.mockResolvedValue(saved({ runAt: "2099-06-20T12:00:00+10:00" }));
    editor();
    fireEvent.click(trigger());
    fireEvent.input(await screen.findByLabelText("Date"), { target: { value: "2099-06-20" } });
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("sends the organiser to sign in when the session has expired", async () => {
    authFetchMock.mockResolvedValue(json({}, 401));
    editor();
    fireEvent.click(trigger());
    fireEvent.input(await screen.findByLabelText("Date"), { target: { value: "2099-06-20" } });
    // An untimed task offers no "Clear time": there is nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear time" })).toBeNull();
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });

  it("opens a linked task on its event, its minutes and its side, and says where that lands", async () => {
    authFetchMock.mockResolvedValue(saved({ eventId: "evt_reception", anchored: true }));
    editor({
      task: task({
        runAt: "2099-06-20T19:30:00+10:00",
        runTimezone: "Australia/Sydney",
        eventId: "evt_reception",
        runOffsetMinutes: 90,
        anchored: true,
      }),
    });
    fireEvent.click(trigger());
    expect(((await screen.findByLabelText("Event")) as HTMLSelectElement).value).toBe(
      "evt_reception",
    );
    expect(
      (screen.getByRole("radio", { name: "Before or after the start" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((screen.getByLabelText("Minutes") as HTMLInputElement).value).toBe("90");
    expect((screen.getByLabelText("Before or after") as HTMLSelectElement).value).toBe("after");
    expect(screen.getByText(/^Sat 20 Jun, 7:30\s?pm, on Reception's clock$/)).toBeTruthy();

    fireEvent.input(screen.getByLabelText("Minutes"), { target: { value: "45" } });
    expect(screen.getByText(/^Sat 20 Jun, 6:45\s?pm, on Reception's clock$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sentRunTime()).toEqual({
        kind: "offset",
        eventId: "evt_reception",
        offsetMinutes: 45,
      }),
    );
  });

  it("takes a whole day before the start at most", async () => {
    authFetchMock.mockResolvedValue(saved({ eventId: "evt_ceremony", anchored: true }));
    editor();
    fireEvent.click(trigger());
    fireEvent.change(await screen.findByLabelText("Event"), { target: { value: "evt_ceremony" } });
    fireEvent.input(screen.getByLabelText("Minutes"), { target: { value: "1440" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sentRunTime()).toEqual({
        kind: "offset",
        eventId: "evt_ceremony",
        offsetMinutes: -1440,
      }),
    );
  });

  it("says what is missing, and sends nothing", async () => {
    editor();
    fireEvent.click(trigger());
    await screen.findByLabelText("Event");
    // No time yet, on the day the events give it.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Pick a date and a time.")).toBeTruthy();
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "14:00" } });
    fireEvent.input(screen.getByLabelText("Date"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Pick a date and a time.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "evt_ceremony" } });
    for (const typed of ["", "1441", "2.5", "30x"]) {
      fireEvent.input(screen.getByLabelText("Minutes"), { target: { value: typed } });
      // Nowhere to land: the line names the event instead.
      expect(screen.getByText("Moves with Ceremony.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(
        await screen.findByText("Minutes must be a whole number from 0 to 1440."),
        `"${typed}" refused`,
      ).toBeTruthy();
    }
    expect(authFetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("offers the events in the order they start, each with its day and time", async () => {
    editor({
      events: [
        // Two at one start: the schedule's own order decides.
        event({ id: "c", name: "Reception", startAt: "2099-06-20T18:00:00+10:00", sortOrder: 1 }),
        event({ id: "b", name: "Speeches", startAt: "2099-06-20T18:00:00+10:00", sortOrder: 0 }),
        event({ id: "a", name: "Rehearsal", startAt: "2099-06-19T18:00:00+10:00" }),
        event({ id: "d", name: "Ceremony", startAt: "2099-06-20T15:00:00+10:00" }),
      ],
    });
    fireEvent.click(trigger());
    const picker = (await screen.findByLabelText("Event")) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent?.replace(/\s/g, " "))).toEqual([
      "No event — a fixed time",
      "Rehearsal · Fri 19 Jun, 6:00 pm",
      "Ceremony · Sat 20 Jun, 3:00 pm",
      "Speeches · Sat 20 Jun, 6:00 pm",
      "Reception · Sat 20 Jun, 6:00 pm",
    ]);
  });

  it("starts a new time on the first event's day, and follows a picked event's until a date is typed", async () => {
    editor({
      events: [
        event({ id: "evt_ceremony", name: "Ceremony" }),
        event({ id: "evt_rehearsal", name: "Rehearsal", startAt: "2099-06-19T18:00:00+10:00" }),
      ],
    });
    fireEvent.click(trigger());
    const date = () => (screen.getByLabelText("Date") as HTMLInputElement).value;
    await screen.findByLabelText("Event");
    expect(date()).toBe("2099-06-19");
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "evt_ceremony" } });
    fireEvent.click(screen.getByRole("radio", { name: "At a clock time" }));
    expect(date()).toBe("2099-06-20");
    fireEvent.input(screen.getByLabelText("Date"), { target: { value: "2099-06-25" } });
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "evt_rehearsal" } });
    expect(date()).toBe("2099-06-25");
  });

  it("defaults a fixed time to the zone the events share, not the browser's", async () => {
    editor({
      events: [
        event({ id: "a", name: "Mehndi", timezone: "Asia/Kolkata" }),
        event({ id: "b", name: "Sangeet", timezone: "Asia/Kolkata" }),
      ],
    });
    fireEvent.click(trigger());
    expect(((await screen.findByLabelText("Time zone")) as HTMLSelectElement).value).toBe(
      "Asia/Kolkata",
    );
  });

  it("names a zone on the trigger only when it is not the reader's, and a removed event", () => {
    // The runner's zone is Sydney's.
    editor({
      task: task({ runAt: "2099-06-20T10:00:00+05:30", runTimezone: "Asia/Kolkata" }),
    });
    expect(trigger().textContent).toMatch(/^10:00\s?amGMT\+5:30,/);
    cleanup();
    editor({
      task: task({
        runAt: "2099-06-20T15:00:00+10:00",
        runTimezone: "Australia/Sydney",
        eventRemoved: true,
      }),
    });
    expect(trigger().textContent).toMatch(
      /^3:00\s?pm, time for Bring the rings, its event removed$/,
    );
  });
  it("links some minutes after the start when after is picked, also after a look at the clock", async () => {
    authFetchMock.mockResolvedValue(saved({ eventId: "evt_ceremony", anchored: true }));
    editor();
    fireEvent.click(trigger());
    fireEvent.change(await screen.findByLabelText("Event"), { target: { value: "evt_ceremony" } });
    fireEvent.click(screen.getByRole("radio", { name: "At a clock time" }));
    fireEvent.click(screen.getByRole("radio", { name: "Before or after the start" }));
    fireEvent.input(screen.getByLabelText("Minutes"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Before or after"), { target: { value: "after" } });
    expect(screen.getByText(/^Sat 20 Jun, 3:20\s?pm, on Ceremony's clock$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sentRunTime()).toEqual({ kind: "offset", eventId: "evt_ceremony", offsetMinutes: 20 }),
    );
  });

  it("closes on Cancel and sends nothing", async () => {
    editor();
    fireEvent.click(trigger());
    fireEvent.input(await screen.findByLabelText("Time"), { target: { value: "12:00" } });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"));
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("sends one write when Save is pressed twice", async () => {
    let answer: (r: Response) => void = () => {};
    authFetchMock.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    editor();
    fireEvent.click(trigger());
    fireEvent.input(await screen.findByLabelText("Date"), { target: { value: "2099-06-20" } });
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy());
    fireEvent.submit(screen.getByRole("button", { name: "Saving…" }).closest("form")!);
    answer(saved({ runAt: "2099-06-20T12:00:00+10:00" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    expect(authFetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("says the events are loading, or that they failed, and names the task's event as best it can", async () => {
    const linkedTask = task({
      runAt: "2099-06-20T14:30:00+10:00",
      runTimezone: "Australia/Sydney",
      eventId: "evt_gone",
      runOffsetMinutes: -30,
      anchored: true,
    });
    editor({ task: linkedTask, events: null });
    fireEvent.click(trigger());
    const options = async () =>
      [...((await screen.findByLabelText("Event")) as HTMLSelectElement).options].map(
        (o) => o.textContent,
      );
    expect(await options()).toEqual([
      "No event — a fixed time",
      "Loading the events…",
      "Its event",
    ]);
    expect(screen.queryByText("Couldn't load the events: set a fixed time.")).toBeNull();
    cleanup();

    editor({ task: linkedTask, events: null, eventsFailed: true });
    fireEvent.click(trigger());
    expect(await options()).toEqual(["No event — a fixed time", "Its event"]);
    expect(screen.getByText("Couldn't load the events: set a fixed time.")).toBeTruthy();
    cleanup();

    // Loaded, without the task's event: it was taken off the schedule.
    editor({ task: linkedTask });
    fireEvent.click(trigger());
    expect(await options()).toEqual([
      "No event — a fixed time",
      "An event no longer on the schedule",
      expect.stringMatching(/^Ceremony · /),
      expect.stringMatching(/^Reception · /),
    ]);
  });

  it("sets a fixed time in a zone picked from the list", async () => {
    authFetchMock.mockResolvedValue(saved({ runAt: "2099-06-20T12:00:00+01:00" }));
    editor();
    fireEvent.click(trigger());
    // A zone every runtime's list spells the same way (Node's names Kolkata
    // "Asia/Calcutta").
    fireEvent.change(await screen.findByLabelText("Time zone"), {
      target: { value: "Europe/London" },
    });
    fireEvent.input(screen.getByLabelText("Date"), { target: { value: "2099-06-20" } });
    fireEvent.input(screen.getByLabelText("Time"), { target: { value: "12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sentRunTime()).toEqual({
        kind: "fixed",
        at: "2099-06-20T12:00",
        timezone: "Europe/London",
      }),
    );
  });
});
