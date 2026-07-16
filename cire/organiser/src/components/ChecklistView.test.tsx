// @vitest-environment happy-dom
import { cleanup, render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetTasksCache, setCachedTasks, type TaskRow } from "../lib/tasks-store";
import ChecklistView from "./ChecklistView";

// useAuth: a stub authFetch we drive per-test.
const authFetch = vi.fn();
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

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
