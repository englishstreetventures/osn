// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetTasksCache, setCachedTasks, type TaskRow } from "../lib/tasks-store";
import ChecklistView from "./ChecklistView";

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
});
