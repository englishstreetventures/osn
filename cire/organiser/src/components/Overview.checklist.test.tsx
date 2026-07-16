// @vitest-environment happy-dom
import { render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCachedEvents } from "../lib/events-store";
import { setCachedGuests } from "../lib/guests-store";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../lib/tasks-store";
import Overview from "./Overview";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const authFetch = vi.fn(async (url: string) => {
  if (url.endsWith("/settings"))
    return json({ wedding: { weddingDate: null, currency: "AUD", budgetTotalMinor: null } });
  if (url.endsWith("/rsvps")) return json({ events: [] });
  if (url.endsWith("/tasks")) return json({ tasks: [] });
  if (url.endsWith("/events")) return json([]);
  if (url.endsWith("/guests")) return json([]);
  return json({}, 404);
});
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

vi.mock("./GettingStarted", () => ({
  default: (p: { weddingId: string }) => <div data-testid="getting-started">{p.weddingId}</div>,
}));

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "t",
  weddingId: "wed_1",
  title: "T",
  notes: null,
  timeframeBucket: "6m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  ...over,
});

beforeEach(() => {
  __resetTasksCache();
  authFetch.mockClear();
  // Seed events + guests so isFresh() = false and the snapshot grid renders.
  setCachedEvents("wed_1", [{ id: "e1", name: "Ceremony" } as never]);
  setCachedGuests("wed_1", [{ familyId: "fam_a", firstName: "Al" } as never]);
});

describe("Overview checklist widget", () => {
  it("shows the live open-task count once tasks are cached", async () => {
    setCachedTasks("wed_1", [row({ id: "a", status: "open" }), row({ id: "b", status: "done" })]);
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    // "1 open task" surfaces on the Checklist card. The count ("1") is in a child
    // <span> inside a <p>, so wait for the span holding the count to appear.
    const countSpan = await screen.findByText("1", { selector: "span" });
    expect(countSpan).toBeInTheDocument();
    // The containing <p> text should read "1 open task".
    const p = countSpan.closest("p");
    expect(p?.textContent?.replace(/\s+/g, " ").trim()).toMatch(/1 open task/i);
  });
});
