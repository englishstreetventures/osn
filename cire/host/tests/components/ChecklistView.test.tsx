// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChecklistView from "../../src/components/ChecklistView";
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
  it("keeps each bucket's rows and reorder arrows inside their own section", async () => {
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
    expect(twelve.getAllByRole("button", { name: "Move up" })[0]).toBeDisabled();
    expect(twelve.getAllByRole("button", { name: "Move down" })[1]).toBeDisabled();
    expect(six.getAllByRole("button", { name: "Move up" })[0]).toBeDisabled();
    expect(six.getAllByRole("button", { name: "Move down" })[1]).toBeDisabled();
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
    fireEvent.click(six.getAllByRole("button", { name: "Move up" })[1]!);

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
