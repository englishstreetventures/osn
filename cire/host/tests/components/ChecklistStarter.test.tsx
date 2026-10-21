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
import {
  __resetTasksCache,
  hasCachedTasks,
  setCachedTasks,
  type TaskRow,
} from "../../src/lib/tasks-store";
import {
  authFetchMock,
  redirectSpy,
  resetOrganiserMocks,
  toastError,
  toastSuccess,
} from "../test-support/mocks";

// The starter checklist from the checklist's side: who is offered it and how,
// what the preview shows and asks for, which items an apply sends, and what the
// couple sees when a request fails.

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
  assigneeHostIds: [],
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

const BUDGET: Item = {
  key: "agree-budget",
  title: "Agree on an overall budget",
  timeframeBucket: "12m",
  dueAt: null,
  state: "new",
};

function renderChecklist(opts: { canEdit?: boolean; canManage?: boolean } = {}) {
  render(() => (
    <ChecklistView
      weddingId="wed_1"
      canEdit={opts.canEdit ?? true}
      canManage={opts.canManage ?? true}
    />
  ));
}

const dialogNamed = () => screen.queryByRole("dialog", { name: "Starter checklist" });

async function openPreview(name: string = "Preview the starter checklist") {
  fireEvent.click(await screen.findByRole("button", { name }));
  return within(await screen.findByRole("dialog", { name: "Starter checklist" }));
}

const postCall = () => authFetchMock.mock.calls.find(([, init]) => init?.method === "POST");
const sentItems = () => (JSON.parse(String(postCall()![1].body)) as { items: string[] }).items;

beforeEach(() => {
  __resetTasksCache();
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  vi.useRealTimers();
});

describe("where the starter checklist is offered", () => {
  it("is not offered to a viewer", async () => {
    setCachedTasks("wed_1", []);
    renderChecklist({ canEdit: false, canManage: false });
    await screen.findByRole("heading", { name: "12+ months out" });
    expect(screen.queryByRole("button", { name: /starter checklist/i })).not.toBeInTheDocument();
  });

  it("is not offered before the checklist has loaded", async () => {
    authFetchMock.mockReturnValueOnce(new Promise(() => {}));
    renderChecklist();
    await screen.findByRole("heading", { name: "12+ months out" });
    expect(screen.queryByRole("button", { name: /starter checklist/i })).not.toBeInTheDocument();
  });

  it("gets a card of its own on an empty checklist, and no dialog until asked", async () => {
    setCachedTasks("wed_1", []);
    renderChecklist();
    expect(
      await screen.findByRole("heading", { name: "Start from a suggested checklist" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview the starter checklist" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Starter checklist" })).not.toBeInTheDocument();
    expect(dialogNamed()).toBeNull();
  });

  it("is a quiet button once the checklist has tasks", async () => {
    setCachedTasks("wed_1", [task({})]);
    renderChecklist();
    expect(await screen.findByRole("button", { name: "Starter checklist" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Start from a suggested checklist" }),
    ).not.toBeInTheDocument();
  });
});

describe("the starter's preview", () => {
  it("asks an owner for the wedding date, and shows no due dates without one", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview(null, [BUDGET]));
    renderChecklist();
    const dialog = await openPreview();
    expect(await dialog.findByText(/add your wedding date in settings/i)).toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /agree on an overall budget/i })).toBeChecked();
    expect(dialog.queryByText(/due \d/)).not.toBeInTheDocument();
    expect(dialog.queryByText("You removed these earlier")).not.toBeInTheDocument();
    expect(dialog.queryByText(/already on your checklist/)).not.toBeInTheDocument();
    expect(authFetchMock.mock.calls[0]![0]).toBe(PREVIEW_URL);
  });

  it("tells an editor an owner sets the date, since only an owner can", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview(null, [BUDGET]));
    renderChecklist({ canManage: false });
    const dialog = await openPreview();
    expect(await dialog.findByText(/when an owner adds the wedding date/i)).toBeInTheDocument();
    expect(dialog.queryByText(/add your wedding date in settings/i)).not.toBeInTheDocument();
  });

  it("says it is loading until the preview arrives", async () => {
    setCachedTasks("wed_1", []);
    let answer!: (res: Response) => void;
    authFetchMock.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    renderChecklist();
    const dialog = await openPreview();
    const status = dialog.getByRole("status");
    expect(status).toHaveTextContent("Loading…");
    const list = status.closest("[aria-busy]")!;
    expect(list).toHaveAttribute("aria-busy", "true");
    expect(dialog.getByRole("button", { name: "Add 0 tasks" })).toBeDisabled();
    answer(preview(null, [BUDGET]));
    await dialog.findByRole("checkbox", { name: /agree on an overall budget/i });
    expect(dialog.queryByText("Loading…")).not.toBeInTheDocument();
    expect(list).toHaveAttribute("aria-busy", "false");
  });

  it("says so when everything is already on the checklist, and offers nothing to add", async () => {
    setCachedTasks("wed_1", [task({ title: "Agree on an overall budget" })]);
    authFetchMock.mockResolvedValueOnce(preview(null, [{ ...BUDGET, state: "added" }]));
    renderChecklist();
    const dialog = await openPreview("Starter checklist");
    expect(
      await dialog.findByText("Everything in the starter checklist is already on yours."),
    ).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Add 0 tasks" })).toBeDisabled();
  });

  it("explains a failed preview, and loads afresh when opened again", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(json({ error: "Internal error" }, 500));
    renderChecklist();
    let dialog = await openPreview();
    expect(await dialog.findByText(/couldn't load the starter checklist/i)).toBeInTheDocument();

    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialogNamed()).toBeNull());
    authFetchMock.mockResolvedValueOnce(preview(null, [BUDGET]));
    dialog = await openPreview();
    await dialog.findByRole("checkbox", { name: /agree on an overall budget/i });
    expect(dialog.queryByText(/couldn't load the starter checklist/i)).not.toBeInTheDocument();
  });

  it.each([
    ["answers 401", () => authFetchMock.mockResolvedValueOnce(json({}, 401))],
    [
      "finds the session expired",
      () => authFetchMock.mockRejectedValueOnce(new Error("AuthExpiredError")),
    ],
  ])("sends an organiser to sign in when the preview %s", async (_case, arrange) => {
    setCachedTasks("wed_1", []);
    arrange();
    renderChecklist();
    await openPreview();
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });
});

describe("the starter with a wedding date", () => {
  const ITEMS: Item[] = [
    {
      key: "book-venues",
      title: "Visit and book your venues",
      timeframeBucket: "12m",
      dueAt: "2026-06-05",
      state: "new",
    },
    {
      key: "confirm-numbers",
      title: "Confirm final guest numbers with suppliers",
      timeframeBucket: "1m",
      dueAt: "2026-10-20",
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
    // "Today" is 20 October 2026: the venue's date has passed, the numbers are
    // due today, the invitations are months ahead.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 20, 12));
  });

  it("leaves a past-due item and a removed one unticked, and sends neither", async () => {
    setCachedTasks("wed_1", [task({ title: "Agree on an overall budget" })]);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    authFetchMock.mockResolvedValueOnce(json({ added: 2, tasks: [] }));
    renderChecklist();
    const dialog = await openPreview("Starter checklist");

    expect(
      await dialog.findByRole("checkbox", { name: /visit and book your venues/i }),
    ).not.toBeChecked();
    expect(dialog.getByText("due 2026-06-05 · date passed")).toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /confirm final guest numbers/i })).toBeChecked();
    expect(dialog.getByText("due 2026-10-20")).toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /send your invitations/i })).toBeChecked();
    expect(dialog.getByText("due 2027-03-07")).toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /plan what you will wear/i })).not.toBeChecked();
    expect(dialog.getByText("You removed these earlier")).toBeInTheDocument();
    expect(dialog.queryByRole("checkbox", { name: /agree on an overall budget/i })).toBeNull();
    expect(dialog.getByText("1 already on your checklist.")).toBeInTheDocument();
    expect(dialog.queryByText(/wedding date in settings/i)).not.toBeInTheDocument();
    // Only buckets with something to add get a heading.
    expect(dialog.getByRole("heading", { name: "12+ months out" })).toBeInTheDocument();
    expect(dialog.queryByRole("heading", { name: "9 months out" })).not.toBeInTheDocument();

    fireEvent.click(dialog.getByRole("button", { name: "Add 2 tasks" }));
    await waitFor(() =>
      expect(sentItems().toSorted()).toEqual(["confirm-numbers", "send-invitations"]),
    );
    expect((postCall()![1].headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("sends a past-due or removed item once the couple ticks it, and drops one unticked", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    authFetchMock.mockResolvedValueOnce(json({ added: 3, tasks: [] }));
    renderChecklist();
    const dialog = await openPreview();

    fireEvent.click(await dialog.findByRole("checkbox", { name: /visit and book your venues/i }));
    fireEvent.click(dialog.getByRole("checkbox", { name: /plan what you will wear/i }));
    fireEvent.click(dialog.getByRole("checkbox", { name: /confirm final guest numbers/i }));
    fireEvent.click(dialog.getByRole("button", { name: "Add 3 tasks" }));
    await waitFor(() =>
      expect(sentItems().toSorted()).toEqual(["book-venues", "plan-outfits", "send-invitations"]),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Added 3 tasks to your checklist."),
    );
  });

  it("offers nothing to add once every item is unticked", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    renderChecklist();
    const dialog = await openPreview();
    fireEvent.click(await dialog.findByRole("checkbox", { name: /send your invitations/i }));
    expect(dialog.getByRole("button", { name: "Add 1 task" })).toBeEnabled();
    fireEvent.click(dialog.getByRole("checkbox", { name: /confirm final guest numbers/i }));
    expect(dialog.getByRole("button", { name: "Add 0 tasks" })).toBeDisabled();
  });

  it("shows the applied tasks from the answer, closes, and keeps the answer as the list", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    let answer!: (res: Response) => void;
    authFetchMock.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    renderChecklist();
    const dialog = await openPreview();
    fireEvent.click(await dialog.findByRole("button", { name: "Add 2 tasks" }));

    // While the apply is in flight it cannot be sent twice.
    const adding = await dialog.findByRole("button", { name: "Adding…" });
    expect(adding).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();

    answer(
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
    const three = await screen.findByTestId("tasks-3m");
    expect(within(three).getByText("Send your invitations")).toBeInTheDocument();
    await waitFor(() => expect(dialogNamed()).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith("Added 1 task to your checklist.");
    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(hasCachedTasks("wed_1")).toBe(true);
  });

  it("shows the applied tasks from an API that names no holders on them", async () => {
    // The API before holders names a task's one assignee as `assignedHostId`
    // and sends no `assigneeHostIds`; a release can put this portal in front of it.
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    const applied: Partial<TaskRow> & { assignedHostId: null } = {
      ...task({
        id: "tsk_inv",
        title: "Send your invitations",
        timeframeBucket: "3m",
        dueAt: "2027-03-07",
      }),
      assignedHostId: null,
    };
    delete applied.assigneeHostIds;
    authFetchMock.mockResolvedValueOnce(json({ added: 1, tasks: [applied] }));
    renderChecklist();
    const dialog = await openPreview();
    fireEvent.click(await dialog.findByRole("button", { name: "Add 2 tasks" }));

    const three = await screen.findByTestId("tasks-3m");
    expect(within(three).getByText("Send your invitations")).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Assign people to Send your invitations" })
        .querySelectorAll("[data-holder]"),
    ).toHaveLength(0);
    await waitFor(() => expect(dialogNamed()).toBeNull());
  });

  it("starts a reopened preview from nothing ticked, so a pick from before cannot be sent", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    renderChecklist();
    let dialog = await openPreview();
    fireEvent.click(await dialog.findByRole("checkbox", { name: /plan what you will wear/i }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialogNamed()).toBeNull());

    authFetchMock.mockReturnValueOnce(new Promise(() => {}));
    dialog = await openPreview();
    expect(dialog.getByRole("button", { name: "Add 0 tasks" })).toBeDisabled();
  });

  it("closes on Escape mid-apply, reports a failure there as a toast, and opens again", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    let answer!: (res: Response) => void;
    authFetchMock.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    renderChecklist();
    const dialog = await openPreview();
    fireEvent.click(await dialog.findByRole("button", { name: "Add 2 tasks" }));
    await dialog.findByRole("button", { name: "Adding…" });

    // What the browser does on Escape: close the element, then fire `close`.
    const element = screen.getByRole("dialog", { name: "Starter checklist" });
    element.removeAttribute("open");
    element.dispatchEvent(new Event("close"));
    answer(json({ error: "Internal error" }, 500));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't add those tasks. Try again in a moment."),
    );

    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    const again = await openPreview();
    expect(await again.findByRole("checkbox", { name: /send your invitations/i })).toBeChecked();
  });

  it("says when nothing was new to add", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    authFetchMock.mockResolvedValueOnce(json({ added: 0, tasks: [] }));
    renderChecklist();
    const dialog = await openPreview();
    fireEvent.click(await dialog.findByRole("button", { name: "Add 2 tasks" }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Those tasks are already on your checklist."),
    );
  });

  it("keeps the dialog open after a failed apply, says so, and lets the couple try again", async () => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    authFetchMock.mockResolvedValueOnce(json({ error: "Internal error" }, 500));
    renderChecklist();
    let dialog = await openPreview();
    fireEvent.click(await dialog.findByRole("button", { name: "Add 2 tasks" }));
    expect(await dialog.findByText(/couldn't add those tasks/i)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Add 2 tasks" })).toBeEnabled();
    expect(dialogNamed()).toBeVisible();

    // A fresh look clears the old failure.
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialogNamed()).toBeNull());
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    dialog = await openPreview();
    await dialog.findByRole("checkbox", { name: /send your invitations/i });
    expect(dialog.queryByText(/couldn't add those tasks/i)).not.toBeInTheDocument();
  });

  it.each([
    ["answers 401", () => authFetchMock.mockResolvedValueOnce(json({}, 401))],
    [
      "finds the session expired",
      () => authFetchMock.mockRejectedValueOnce(new Error("AuthExpiredError")),
    ],
  ])("sends an organiser to sign in when the apply %s", async (_case, arrange) => {
    setCachedTasks("wed_1", []);
    authFetchMock.mockResolvedValueOnce(preview("2027-06-05", ITEMS));
    arrange();
    renderChecklist();
    const dialog = await openPreview();
    fireEvent.click(await dialog.findByRole("button", { name: "Add 2 tasks" }));
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });
});
