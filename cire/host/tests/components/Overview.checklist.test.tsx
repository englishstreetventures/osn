// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Overview from "../../src/components/Overview";
import { __resetBudgetCache } from "../../src/lib/budget-store";
import { setCachedEvents } from "../../src/lib/events-store";
import { setCachedGuests } from "../../src/lib/guests-store";
import { TasksChangedContext } from "../../src/lib/tasks-changed";
import {
  __resetTasksCache,
  setCachedTasks,
  type TaskRow,
  viewerHostIdOf,
} from "../../src/lib/tasks-store";

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
  if (url.endsWith("/budget"))
    return json({ items: [], payments: [], budgetTotalMinor: null, currency: "AUD" });
  return json({}, 404);
});
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

// An expired session is this one error; signing in again is this spy.
const auth = vi.hoisted(() => ({ expired: new Error("session expired"), redirect: vi.fn() }));
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    apiUrl: (path: string) => `https://api.test${path}`,
    isAuthExpired: (err: unknown) => err === auth.expired,
    redirectToLogin: auth.redirect,
  };
});

vi.mock("../../src/components/GettingStarted", () => ({
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
  assigneeHostIds: [],
  ...over,
});

beforeEach(() => {
  __resetBudgetCache();
  __resetTasksCache();
  authFetch.mockClear();
  // Seed events + guests so isFresh() = false and the snapshot grid renders.
  setCachedEvents("wed_1", [{ id: "e1", name: "Ceremony" } as never]);
  setCachedGuests("wed_1", [{ familyId: "fam_a", firstName: "Al" } as never]);
});

afterEach(() => {
  cleanup();
});

describe("Overview checklist widget", () => {
  it("keeps the reader's own seat from its read of the tasks, for the checklist's holder order", async () => {
    const answer = authFetch.getMockImplementation()!;
    authFetch.mockImplementation(async (url: string) =>
      url.endsWith("/tasks")
        ? json({ tasks: [row({ id: "a" })], viewerHostId: "whost_me" })
        : answer(url),
    );
    try {
      render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);
      await waitFor(() => expect(viewerHostIdOf("wed_1")).toBe("whost_me"));
    } finally {
      authFetch.mockImplementation(answer);
    }
  });

  it("shows the N-of-M completion line", async () => {
    setCachedTasks("wed_1", [row({ id: "a", status: "open" }), row({ id: "b", status: "done" })]);
    render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);
    expect(await screen.findByText(/1 of 2 done/i)).toBeInTheDocument();
  });

  it("shows the live open-task count once tasks are cached", async () => {
    setCachedTasks("wed_1", [row({ id: "a", status: "open" }), row({ id: "b", status: "done" })]);
    render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);
    // "1 open task" surfaces on the Checklist card. The count ("1") is in a child
    // <span> inside a <p>, so wait for the span holding the count to appear.
    const countSpan = await screen.findByText("1", { selector: "span" });
    expect(countSpan).toBeInTheDocument();
    // The containing <p> text should read "1 open task".
    const p = countSpan.closest("p");
    expect(p?.textContent?.replace(/\s+/g, " ").trim()).toMatch(/1 open task/i);
  });

  /**
   * Regression test for #620, the twin of the two cases above. Both of those
   * call `setCachedTasks` BEFORE `render`, which mints the wedding's cache
   * entry ahead of time — the one state the pre-branch
   * `cache.get(id)?.tasks() ?? null` reader handled correctly. Starting cold
   * here (no seed) is what makes this case fail against the old reader:
   * `taskCounts` was read for the first time while the cache was still
   * empty, registered no dependency, and the Checklist card stayed on
   * "Loading your tasks…" forever even after the fetch resolved.
   */
  it("cold: resolves off 'Loading your tasks…' once the tasks fetch completes", async () => {
    authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/settings"))
        return json({ wedding: { weddingDate: null, currency: "AUD", budgetTotalMinor: null } });
      if (url.endsWith("/rsvps")) return json({ events: [] });
      if (url.endsWith("/tasks"))
        return json({
          tasks: [row({ id: "a", status: "open" }), row({ id: "b", status: "done" })],
        });
      if (url.endsWith("/events")) return json([]);
      if (url.endsWith("/guests")) return json([]);
      if (url.endsWith("/budget"))
        return json({ items: [], payments: [], budgetTotalMinor: null, currency: "AUD" });
      return json({}, 404);
    });
    render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);

    const checklistCard = (await screen.findByText("Checklist")).closest("button")!;
    await waitFor(() =>
      expect(checklistCard.textContent!.replace(/\s+/g, " ").trim()).toMatch(/1 of 2 done/i),
    );
    expect(checklistCard.textContent).not.toMatch(/Loading your tasks…/i);
  });
});

describe("Overview checklist widget — the open wedding's signals", () => {
  const tasksCalls = () => authFetch.mock.calls.filter(([url]) => url.endsWith("/tasks"));

  function renderWithSignal(tier: "ivory" | "crimson") {
    const [tasksChanged, setTasksChanged] = createSignal(0);
    render(() => (
      <TasksChangedContext.Provider value={tasksChanged}>
        <Overview weddingId="wed_1" tier={tier} onNavigate={() => {}} />
      </TasksChangedContext.Provider>
    ));
    return () => setTasksChanged((n) => n + 1);
  }

  it("reads the tasks again on tasks-changed, and shows the new count", async () => {
    const answer = authFetch.getMockImplementation()!;
    let done = 0;
    authFetch.mockImplementation(async (url: string) =>
      url.endsWith("/tasks")
        ? json({
            tasks: [
              row({ id: "a", status: done > 0 ? "done" : "open" }),
              row({ id: "b", status: "done" }),
              row({ id: "c", status: "open" }),
            ],
          })
        : answer(url),
    );
    try {
      const tasksChanged = renderWithSignal("crimson");
      expect(await screen.findByText(/1 of 3 done/i)).toBeInTheDocument();

      done = 1;
      tasksChanged();

      expect(await screen.findByText(/2 of 3 done/i)).toBeInTheDocument();
      expect(tasksCalls()).toHaveLength(2);
    } finally {
      authFetch.mockImplementation(answer);
    }
  });

  it("sends one more read, not one per signal, for a burst that lands while a read is out", async () => {
    const answer = authFetch.getMockImplementation()!;
    let reads = 0;
    let answerHeld!: (res: Response) => void;
    const tasks = (done: number, more: TaskRow[] = []) =>
      json({
        tasks: [
          row({ id: "a", status: done > 1 ? "done" : "open" }),
          row({ id: "b", status: "done" }),
          row({ id: "c", status: "open" }),
          ...more,
        ],
      });
    authFetch.mockImplementation(async (url: string) => {
      if (!url.endsWith("/tasks")) return answer(url);
      reads += 1;
      if (reads === 2) {
        return new Promise<Response>((resolve) => {
          answerHeld = resolve;
        });
      }
      return reads === 1 ? tasks(1) : tasks(2, [row({ id: "d", status: "open" })]);
    });
    try {
      const tasksChanged = renderWithSignal("crimson");
      expect(await screen.findByText(/1 of 3 done/i)).toBeInTheDocument();

      tasksChanged();
      await waitFor(() => expect(tasksCalls()).toHaveLength(2));
      tasksChanged();
      tasksChanged();
      tasksChanged();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tasksCalls()).toHaveLength(2);

      answerHeld(tasks(2));

      expect(await screen.findByText(/2 of 4 done/i)).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tasksCalls()).toHaveLength(3);
    } finally {
      authFetch.mockImplementation(answer);
    }
  });

  it("sends an expired session to sign in when the re-read finds it", async () => {
    const answer = authFetch.getMockImplementation()!;
    let reads = 0;
    authFetch.mockImplementation(async (url: string) => {
      if (!url.endsWith("/tasks")) return answer(url);
      reads += 1;
      if (reads > 1) throw auth.expired;
      return json({ tasks: [row({ id: "a" })] });
    });
    auth.redirect.mockClear();
    try {
      const tasksChanged = renderWithSignal("crimson");
      await waitFor(() => expect(tasksCalls()).toHaveLength(1));
      expect(auth.redirect).not.toHaveBeenCalled();

      tasksChanged();

      await waitFor(() => expect(auth.redirect).toHaveBeenCalledTimes(1));
    } finally {
      authFetch.mockImplementation(answer);
    }
  });

  it.each([
    ["a 401", 401, 1],
    ["a refusal", 403, 0],
    ["a server error", 500, 0],
  ])(
    "answers %s on the re-read by signing in again only for a 401",
    async (_l, status, redirects) => {
      const answer = authFetch.getMockImplementation()!;
      let reads = 0;
      authFetch.mockImplementation(async (url: string) => {
        if (!url.endsWith("/tasks")) return answer(url);
        reads += 1;
        return reads > 1 ? json({ error: "no" }, status) : json({ tasks: [row({ id: "a" })] });
      });
      auth.redirect.mockClear();
      try {
        const tasksChanged = renderWithSignal("crimson");
        await waitFor(() => expect(tasksCalls()).toHaveLength(1));

        tasksChanged();
        await waitFor(() => expect(tasksCalls()).toHaveLength(2));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(auth.redirect).toHaveBeenCalledTimes(redirects);
      } finally {
        authFetch.mockImplementation(answer);
      }
    },
  );

  it("reads no tasks on a signal while the checklist is locked below Gold", async () => {
    const tasksChanged = renderWithSignal("ivory");
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    tasksChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tasksCalls()).toHaveLength(0);
  });
});
