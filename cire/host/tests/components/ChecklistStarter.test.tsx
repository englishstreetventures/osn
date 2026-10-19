// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import ChecklistView from "../../src/components/ChecklistView";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../../src/lib/tasks-store";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

// The starter checklist from the checklist's side: who is offered it, what the
// preview asks of a wedding with no date, and which items an apply sends.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const task = (over: Partial<TaskRow>): TaskRow => ({
  id: "tsk_1",
  weddingId: "wed_1",
  title: "Our own task",
  notes: null,
  timeframeBucket: "12m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  ...over,
});

interface Item {
  key: string;
  title: string;
  timeframeBucket: string;
  dueAt: string | null;
  state: "new" | "added" | "removed";
}

const PREVIEW_URL = "https://api.test/api/organiser/weddings/wed_1/tasks/templates/starter";

function preview(weddingDate: string | null, items: Item[]) {
  return json({ preview: { templateId: "starter", weddingDate, items } });
}

function renderChecklist(opts: { canEdit?: boolean; canManage?: boolean } = {}) {
  render(() => (
    <ChecklistView
      weddingId="wed_1"
      canEdit={opts.canEdit ?? true}
      canManage={opts.canManage ?? true}
    />
  ));
}

async function openPreview(name: RegExp = /starter checklist/i) {
  fireEvent.click(await screen.findByRole("button", { name }));
  return within(await screen.findByRole("dialog", { name: "Starter checklist" }));
}

beforeEach(() => {
  __resetTasksCache();
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  vi.useRealTimers();
});

describe("the starter checklist", () => {
  it("is not offered to a viewer", async () => {
    setCachedTasks("wed_1", []);
    renderChecklist({ canEdit: false, canManage: false });
    await screen.findByRole("heading", { name: "12+ months out" });
    expect(screen.queryByRole("button", { name: /starter checklist/i })).not.toBeInTheDocument();
  });

  it("asks an owner for the wedding date, and shows no due dates without one", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(
      preview(null, [
        {
          key: "agree-budget",
          title: "Agree on an overall budget",
          timeframeBucket: "12m",
          dueAt: null,
          state: "new",
        },
      ]),
    );
    renderChecklist();
    const dialog = await openPreview();
    expect(
      await dialog.findByText(/add your wedding date in settings/i, { exact: false }),
    ).toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /agree on an overall budget/i })).toBeChecked();
    expect(dialog.queryByText(/due \d/)).not.toBeInTheDocument();
    expect(authFetchMock.mock.calls[0]![0]).toBe(PREVIEW_URL);
  });

  it("tells an editor an owner sets the date, since only an owner can", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview(null, []));
    renderChecklist({ canManage: false });
    const dialog = await openPreview();
    expect(await dialog.findByText(/when an owner adds the wedding date/i)).toBeInTheDocument();
    expect(dialog.queryByText(/add your wedding date in settings/i)).not.toBeInTheDocument();
  });

  describe("with a wedding date", () => {
    const ITEMS: Item[] = [
      {
        key: "book-venues",
        title: "Visit and book your venues",
        timeframeBucket: "12m",
        dueAt: "2026-06-05",
        state: "new",
      },
      {
        key: "send-invitations",
        title: "Send your invitations",
        timeframeBucket: "3m",
        dueAt: "2027-03-07",
        state: "new",
      },
      {
        key: "plan-outfits",
        title: "Plan what you will wear",
        timeframeBucket: "6m",
        dueAt: "2026-12-07",
        state: "removed",
      },
      {
        key: "agree-budget",
        title: "Agree on an overall budget",
        timeframeBucket: "12m",
        dueAt: "2026-06-05",
        state: "added",
      },
    ];

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 20, 12));
    });

    const sentItems = () => {
      const call = authFetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      return (JSON.parse(String(call![1].body)) as { items: string[] }).items;
    };

    it("leaves a past-due item and a removed one unticked, and sends neither", async () => {
      setCachedTasks("wed_1", [task({ title: "Agree on an overall budget" })]);
      authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
      authFetchMock.mockResolvedValueOnce(json({ added: 1, tasks: [] }));
      renderChecklist();
      const dialog = await openPreview();

      const pastDue = await dialog.findByRole("checkbox", { name: /visit and book your venues/i });
      expect(pastDue).not.toBeChecked();
      expect(dialog.getByText(/date passed/i)).toBeInTheDocument();
      expect(dialog.getByRole("checkbox", { name: /plan what you will wear/i })).not.toBeChecked();
      expect(dialog.getByRole("checkbox", { name: /send your invitations/i })).toBeChecked();
      expect(dialog.queryByRole("checkbox", { name: /agree on an overall budget/i })).toBeNull();
      expect(dialog.getByText(/1 already on your checklist/i)).toBeInTheDocument();

      fireEvent.click(dialog.getByRole("button", { name: "Add 1 task" }));
      await waitFor(() => expect(sentItems()).toEqual(["send-invitations"]));
    });

    it("sends a past-due or removed item once the couple ticks it", async () => {
      setCachedTasks("wed_1", []);
      authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
      authFetchMock.mockResolvedValueOnce(json({ added: 3, tasks: [] }));
      renderChecklist();
      const dialog = await openPreview();

      fireEvent.click(await dialog.findByRole("checkbox", { name: /visit and book your venues/i }));
      fireEvent.click(dialog.getByRole("checkbox", { name: /plan what you will wear/i }));
      fireEvent.click(dialog.getByRole("button", { name: "Add 3 tasks" }));
      await waitFor(() =>
        expect(sentItems().toSorted()).toEqual(["book-venues", "plan-outfits", "send-invitations"]),
      );
    });

    it("shows the applied tasks from the answer, without loading the list again", async () => {
      setCachedTasks("wed_1", []);
      authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
      authFetchMock.mockResolvedValueOnce(
        json({
          added: 1,
          tasks: [
            task({
              id: "tsk_inv",
              title: "Send your invitations",
              timeframeBucket: "3m",
              dueAt: "2027-03-07",
            }),
          ],
        }),
      );
      renderChecklist();
      const dialog = await openPreview();
      fireEvent.click(await dialog.findByRole("button", { name: "Add 1 task" }));

      const three = await screen.findByTestId("tasks-3m");
      expect(within(three).getByText("Send your invitations")).toBeInTheDocument();
      expect(authFetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
