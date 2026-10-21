// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChecklistView from "../../src/components/ChecklistView";
import { __resetHostsCache } from "../../src/lib/hosts-store";
import { MembersChangedContext } from "../../src/lib/members-changed";
import { TasksChangedContext } from "../../src/lib/tasks-changed";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../../src/lib/tasks-store";

// useAuth: a stub authFetch we drive per-test.
const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "tsk_1",
  weddingId: "wed_1",
  title: "Book venue",
  notes: null,
  timeframeBucket: "12m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  assigneeHostIds: [],
  ...over,
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  __resetTasksCache();
  authFetch.mockReset();
});

describe("ChecklistView", () => {
  it("groups tasks under their bucket headings", async () => {
    // Seed the cache so the view renders without a network round-trip.
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue", timeframeBucket: "12m" })]);
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    expect(await screen.findByText("Book venue")).toBeInTheDocument();
    // The heading "12+ months out" also appears in the "When" select; use role query for the section heading.
    expect(screen.getByRole("heading", { name: "12+ months out" })).toBeInTheDocument();
  });

  it("hides all write controls for a viewer (read-only)", async () => {
    setCachedTasks("wed_1", [row({ id: "a" })]);
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await screen.findByText("Book venue");
    expect(screen.queryByRole("button", { name: /add task/i })).not.toBeInTheDocument();
  });

  // The buckets are grid siblings rather than a flex column, so a mis-nested
  // </section> or a <For> closed inside the wrong element would put one bucket's
  // rows inside another's. Everything here asserts DOM containment, which holds
  // whether or not the environment applies the grid.
  it("keeps each bucket's rows and reorder controls inside their own section", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", timeframeBucket: "12m", sortOrder: 0 }),
      row({ id: "b", title: "Draft guest list", timeframeBucket: "12m", sortOrder: 1 }),
      row({ id: "c", title: "Send save-the-dates", timeframeBucket: "6m", sortOrder: 0 }),
      row({ id: "d", title: "Book the band", timeframeBucket: "6m", sortOrder: 1 }),
    ]);
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");

    const sectionFor = (heading: string) =>
      screen.getByRole("heading", { name: heading }).closest("section")!;
    const twelve = within(sectionFor("12+ months out"));
    const six = within(sectionFor("6 months out"));

    // Each bucket holds only its own rows.
    expect(twelve.getByText("Book venue")).toBeInTheDocument();
    expect(twelve.queryByText("Send save-the-dates")).not.toBeInTheDocument();
    expect(six.getByText("Send save-the-dates")).toBeInTheDocument();
    expect(six.queryByText("Book venue")).not.toBeInTheDocument();

    // The disabled edges are per bucket, not across the flattened list: each
    // bucket's first row can't move up and its last can't move down.
    expect(twelve.getByRole("button", { name: "Move Book venue up" })).toBeDisabled();
    expect(twelve.getByRole("button", { name: "Move Draft guest list down" })).toBeDisabled();
    expect(six.getByRole("button", { name: "Move Send save-the-dates up" })).toBeDisabled();
    expect(six.getByRole("button", { name: "Move Book the band down" })).toBeDisabled();
  });

  it("reorders within the clicked bucket only", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", timeframeBucket: "12m", sortOrder: 0 }),
      row({ id: "b", title: "Draft guest list", timeframeBucket: "12m", sortOrder: 1 }),
      row({ id: "c", title: "Send save-the-dates", timeframeBucket: "6m", sortOrder: 0 }),
      row({ id: "d", title: "Book the band", timeframeBucket: "6m", sortOrder: 1 }),
    ]);
    authFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Send save-the-dates");

    const six = within(screen.getByRole("heading", { name: "6 months out" }).closest("section")!);
    // Move the SECOND row of the 6-month bucket up.
    fireEvent.click(six.getByRole("button", { name: "Move Book the band up" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [, init] = authFetch.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ timeframeBucket: "6m", orderedIds: ["d", "c"] });
  });

  it("checks a task off (PATCH status done) and updates the row", async () => {
    setCachedTasks("wed_1", [row({ id: "a", status: "open" })]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: row({ id: "a", status: "done", completedAt: 2 }) }), {
        status: 200,
      }),
    );
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const checkbox = await screen.findByRole("checkbox", { name: /book venue/i });
    fireEvent.click(checkbox);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [, init] = authFetch.mock.calls[0]!;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "done" });
  });

  it("loads the list for a task added before the list arrived, instead of passing it off as the list", async () => {
    // The first read fails, so there is no list when the task is created. The
    // new task alone must not be cached as the whole checklist: that would show
    // one task and stop the next load from asking the server.
    let reads = 0;
    authFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task: row({ id: "new", title: "Send invites" }) }), {
          status: 201,
        });
      }
      reads += 1;
      if (reads === 1) return new Response(null, { status: 500 });
      return new Response(
        JSON.stringify({
          tasks: [
            row({ id: "old", title: "Book venue" }),
            row({ id: "new", title: "Send invites", sortOrder: 1 }),
          ],
        }),
        { status: 200 },
      );
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText(/couldn't load your checklist/i);

    fireEvent.input(screen.getByPlaceholderText("Book the venue"), {
      target: { value: "Send invites" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add task/i }));

    expect(await screen.findByText("Book venue")).toBeInTheDocument();
    expect(screen.getByText("Send invites")).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it("adds a task to a loaded list without reading the list again", async () => {
    setCachedTasks("wed_1", [row({ id: "old", title: "Book venue" })]);
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: row({ id: "new", title: "Send invites" }) }), {
        status: 201,
      }),
    );
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");

    fireEvent.input(screen.getByPlaceholderText("Book the venue"), {
      target: { value: "Send invites" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add task/i }));

    expect(await screen.findByText("Send invites")).toBeInTheDocument();
    expect(screen.getByText("Book venue")).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch.mock.calls[0]![1].method).toBe("POST");
  });

  it("removes a deleted task before the server answers", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue" }),
      row({ id: "b", title: "Send invites", sortOrder: 1 }),
    ]);
    authFetch.mockReturnValueOnce(new Promise(() => {}));
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");

    fireEvent.click(screen.getAllByRole("button", { name: /delete/i })[0]!);

    await waitFor(() => expect(screen.queryByText("Book venue")).not.toBeInTheDocument());
    expect(screen.getByText("Send invites")).toBeInTheDocument();
  });
});

describe("ChecklistView — the open wedding's signals", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const calls = (suffix: string) =>
    authFetch.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && !init?.method);

  /** The view under both providers, with a bump for each. */
  function renderWithSignals() {
    const [tasksChanged, setTasksChanged] = createSignal(0);
    const [membersChanged, setMembersChanged] = createSignal(0);
    render(() => (
      <MembersChangedContext.Provider value={membersChanged}>
        <TasksChangedContext.Provider value={tasksChanged}>
          <ChecklistView weddingId="wed_1" canEdit={true} />
        </TasksChangedContext.Provider>
      </MembersChangedContext.Provider>
    ));
    return {
      tasksChanged: () => setTasksChanged((n) => n + 1),
      membersChanged: () => setMembersChanged((n) => n + 1),
    };
  }

  beforeEach(() => {
    __resetHostsCache();
  });

  it("reads the tasks again on tasks-changed and shows the answer", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    authFetch.mockImplementation(async () =>
      json({ tasks: [row({ id: "a", title: "Book the hall" })] }),
    );
    const signals = renderWithSignals();
    await screen.findByText("Book venue");

    signals.tasksChanged();

    expect(await screen.findByText("Book the hall")).toBeInTheDocument();
    expect(calls("/tasks")).toHaveLength(1);
  });

  // The tick's own signal can reach the tab before the tick's answer. The read
  // it asks for waits for the answer, so it can neither undo the tick nor be
  // lost: it goes once the tick is over, and shows what a co-host did meanwhile.
  it("reads once the organiser's own tick has answered, never over it, when its signal lands first", async () => {
    setCachedTasks("wed_1", [row({ id: "a", status: "open" })]);
    let answerTick!: (res: Response) => void;
    let committed = false;
    authFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          answerTick = resolve;
        });
      }
      return committed
        ? json({
            tasks: [
              row({ id: "a", status: "done", completedAt: 2 }),
              row({ id: "b", title: "Order flowers", sortOrder: 1 }),
            ],
          })
        : json({ tasks: [row({ id: "a", status: "open" })] });
    });
    const signals = renderWithSignals();
    // Asked afresh each time: a row may be rebuilt when its task changes.
    const ticked = () =>
      (screen.getByRole("checkbox", { name: /book venue/i }) as HTMLInputElement).checked;
    await screen.findByRole("checkbox", { name: /book venue/i });

    fireEvent.click(screen.getByRole("checkbox", { name: /book venue/i }));
    await waitFor(() => expect(ticked()).toBe(true));
    signals.tasksChanged();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Nothing is read while the tick is out.
    expect(calls("/tasks")).toHaveLength(0);
    expect(ticked()).toBe(true);

    committed = true;
    answerTick(json({ task: row({ id: "a", status: "done", completedAt: 2 }) }));

    expect(await screen.findByText("Order flowers")).toBeInTheDocument();
    expect(calls("/tasks")).toHaveLength(1);
    expect(ticked()).toBe(true);
  });

  it("sends one more read, not one per signal, for a burst that lands while a read is out", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    let answerFirst!: (res: Response) => void;
    let reads = 0;
    authFetch.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        return new Promise<Response>((resolve) => {
          answerFirst = resolve;
        });
      }
      return json({ tasks: [row({ id: "a", title: "Book the hall" })] });
    });
    const signals = renderWithSignals();
    await screen.findByText("Book venue");

    signals.tasksChanged();
    await waitFor(() => expect(calls("/tasks")).toHaveLength(1));
    signals.tasksChanged();
    signals.tasksChanged();
    signals.tasksChanged();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls("/tasks")).toHaveLength(1);

    answerFirst(json({ tasks: [row({ id: "a", title: "Book a band" })] }));

    expect(await screen.findByText("Book the hall")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls("/tasks")).toHaveLength(2);
  });

  it("says the checklist could not refresh when a signal's re-read is refused", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    authFetch.mockImplementation(async () => new Response(null, { status: 500 }));
    const signals = renderWithSignals();
    await screen.findByText("Book venue");

    signals.tasksChanged();

    expect(await screen.findByText("Couldn't refresh your checklist.")).toBeInTheDocument();
  });

  /** The organiser's own writes, each on the cached list of two 12-month tasks. */
  const writes: [string, () => void][] = [
    ["a tick", () => fireEvent.click(screen.getByRole("checkbox", { name: /book venue/i }))],
    ["a delete", () => fireEvent.click(screen.getAllByRole("button", { name: "Delete task" })[0]!)],
    [
      "a move",
      () => fireEvent.click(screen.getByRole("button", { name: "Move Draft guest list up" })),
    ],
    [
      "an add",
      () => {
        fireEvent.input(screen.getByRole("textbox", { name: /^Task/ }), {
          target: { value: "Send invites" },
        });
        fireEvent.click(screen.getByRole("button", { name: /add task/i }));
      },
    ],
  ];
  const twoTasks = () => [
    row({ id: "a", title: "Book venue", sortOrder: 0 }),
    row({ id: "b", title: "Draft guest list", sortOrder: 1 }),
  ];
  const writeCalls = () => authFetch.mock.calls.filter(([, init]) => init?.method);

  it.each(writes)("takes the next re-read once %s has answered", async (_label, write) => {
    setCachedTasks("wed_1", twoTasks());
    authFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(_url).endsWith("/reorder")) return json({ ok: true });
      if (init?.method) return json({ task: row({ id: "c", title: "Send invites" }), ok: true });
      return json({ tasks: [row({ id: "z", title: "From the server" })] });
    });
    const signals = renderWithSignals();
    await screen.findByText("Book venue");

    write();
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    signals.tasksChanged();

    expect(await screen.findByText("From the server")).toBeInTheDocument();
  });

  it.each(writes)("puts the server's list back when %s is refused", async (_label, write) => {
    setCachedTasks("wed_1", twoTasks());
    authFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method
        ? new Response(null, { status: 500 })
        : json({ tasks: [row({ id: "z", title: "From the server" })] }),
    );
    renderWithSignals();
    await screen.findByText("Book venue");

    write();

    // The refusal's own re-read lands: the write is over when it is sent, so
    // it is read once.
    expect(await screen.findByText("From the server")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls("/tasks")).toHaveLength(1);
  });

  it("reads the seats again on members-changed once a popover asked for them", async () => {
    setCachedTasks("wed_1", [row({ id: "a" })]);
    authFetch.mockImplementation(async () => json({ hosts: [] }));
    const signals = renderWithSignals();
    fireEvent.click(await screen.findByRole("button", { name: "Assign people to Book venue" }));
    await waitFor(() => expect(calls("/hosts")).toHaveLength(1));

    signals.membersChanged();

    await waitFor(() => expect(calls("/hosts")).toHaveLength(2));
  });

  it("reads the seats again on members-changed once it has read them, and not before", async () => {
    setCachedTasks("wed_1", [row({ id: "a" })]);
    authFetch.mockImplementation(async () => json({ hosts: [] }));
    const quiet = renderWithSignals();
    await screen.findByText("Book venue");
    quiet.membersChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Nobody holds a task, so no seats were wanted, and none are read.
    expect(calls("/hosts")).toHaveLength(0);
    cleanup();

    __resetTasksCache();
    __resetHostsCache();
    setCachedTasks("wed_1", [row({ id: "a", assigneeHostIds: ["whost_sam"] })]);
    const held = renderWithSignals();
    await waitFor(() => expect(calls("/hosts")).toHaveLength(1));
    held.membersChanged();
    await waitFor(() => expect(calls("/hosts")).toHaveLength(2));
  });
});
