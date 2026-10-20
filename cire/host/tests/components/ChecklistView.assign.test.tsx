// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChecklistView from "../../src/components/ChecklistView";
import { __resetHostsCache, type HostSeat } from "../../src/lib/hosts-store";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../../src/lib/tasks-store";

// Who holds each task, and the drawer that changes it, over a stubbed API.

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
  assignedHostId: null,
  ...over,
});

const SAM: HostSeat = {
  hostId: "whost_sam",
  osnProfileId: "usr_sam",
  handle: "sam",
  displayName: "Sam Lee",
  role: "owner",
};
const JO: HostSeat = { hostId: "whost_jo", osnProfileId: "usr_jo", handle: "jo", role: "helper" };

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** The API, by path: the hosts list, the task list, and the assignee write. */
function api(routes: { hosts?: Route; tasks?: Route; assign?: Route }) {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://api.test").pathname;
    if (path.endsWith("/hosts") && routes.hosts) return routes.hosts(init);
    if (path.endsWith("/assignee") && routes.assign) return routes.assign(init);
    if (path.endsWith("/tasks") && routes.tasks) return routes.tasks(init);
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hostsAnswer = (hosts: HostSeat[]) => () =>
  json({ hosts, total: hosts.length, peopleLimit: null });

const calls = (suffix: string, method = "GET") =>
  authFetch.mock.calls.filter(
    ([url, init]) =>
      new URL(String(url), "https://api.test").pathname.endsWith(suffix) &&
      ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );

/** A task's row on the checklist, by its checkbox — the drawer names the task too. */
const rowOf = (title: string) => screen.getByRole("checkbox", { name: title }).closest("li")!;

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  __resetTasksCache();
  __resetHostsCache();
  authFetch.mockReset();
});

describe("who holds a task", () => {
  it("names each assignee, by display name or else by handle, for a viewer too", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assignedHostId: "whost_sam" }),
      row({ id: "b", title: "Carry the rings", assignedHostId: "whost_jo", sortOrder: 1 }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);

    await waitFor(() => expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible());
    expect(within(rowOf("Carry the rings")).getByText("@jo")).toBeVisible();
    expect(calls("/hosts")).toHaveLength(1);
  });

  it("says “Needs an owner” on every open task nobody holds, and on nothing else", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue" }),
      row({ id: "b", title: "Send invites", sortOrder: 1 }),
      row({ id: "c", title: "Pick a date", status: "done", completedAt: 2, sortOrder: 2 }),
      row({ id: "d", title: "Carry the rings", assignedHostId: "whost_jo", sortOrder: 3 }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await waitFor(() => expect(within(rowOf("Carry the rings")).getByText("@jo")).toBeVisible());

    expect(within(rowOf("Book venue")).getByText("Needs an owner")).toBeVisible();
    expect(within(rowOf("Send invites")).getByText("Needs an owner")).toBeVisible();
    expect(within(rowOf("Pick a date")).queryByText("Needs an owner")).not.toBeInTheDocument();
    expect(within(rowOf("Carry the rings")).queryByText("Needs an owner")).not.toBeInTheDocument();
  });

  it("asks for nobody's names while no task is assigned", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({});
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Needs an owner");
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("offers a viewer no way to change who holds a task", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({});
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await screen.findByText("Book venue");
    expect(screen.queryByRole("button", { name: /^Edit/ })).not.toBeInTheDocument();
  });
});

describe("the task drawer", () => {
  it("asks for the people afresh on every opening, and assigns and unassigns from it", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assignedHostId: "whost_sam" }),
      row({ id: "b", title: "Carry the rings", sortOrder: 1 }),
    ]);
    const assigned: unknown[] = [];
    api({
      hosts: hostsAnswer([SAM, JO]),
      assign: (init) => {
        const body = JSON.parse(String(init?.body)) as { assignedHostId: string | null };
        assigned.push(body);
        return json({ task: row({ id: "b", title: "Carry the rings", sortOrder: 1, ...body }) });
      },
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() => expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible());
    expect(calls("/hosts")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Edit Carry the rings" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit task" });
    // Opening asks again, so someone seated since the page loaded is offered.
    await waitFor(() => expect(calls("/hosts")).toHaveLength(2));
    const select = (await within(drawer).findByLabelText("Assigned to")) as HTMLSelectElement;
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "@jo · Helper" })).toBeTruthy(),
    );
    expect(select.value).toBe("");

    fireEvent.change(select, { target: { value: "whost_jo" } });
    await waitFor(() => expect(assigned).toEqual([{ assignedHostId: "whost_jo" }]));
    const [url, init] = calls("/assignee", "PUT")[0]!;
    expect(new URL(String(url), "https://api.test").pathname).toBe(
      "/api/organiser/weddings/wed_1/tasks/b/assignee",
    );
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "application/json" });
    await waitFor(() => expect(within(rowOf("Carry the rings")).getByText("@jo")).toBeVisible());
    expect(within(rowOf("Carry the rings")).queryByText("Needs an owner")).not.toBeInTheDocument();

    // The next pick waits for the first write to come back.
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(assigned).toEqual([{ assignedHostId: "whost_jo" }, { assignedHostId: null }]),
    );
    await waitFor(() =>
      expect(within(rowOf("Carry the rings")).getByText("Needs an owner")).toBeVisible(),
    );
  });

  it("takes the pick back and asks again when that person is no longer on the wedding", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({
      hosts: hostsAnswer([SAM, JO]),
      assign: () => json({ error: "assignee_not_in_wedding" }, 422),
      tasks: () => json({ tasks: [row({ id: "a", title: "Book venue" })] }),
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");

    fireEvent.click(screen.getByRole("button", { name: "Edit Book venue" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit task" });
    const select = (await within(drawer).findByLabelText("Assigned to")) as HTMLSelectElement;
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "@jo · Helper" })).toBeTruthy(),
    );
    const hostReadsBefore = calls("/hosts").length;

    fireEvent.change(select, { target: { value: "whost_jo" } });

    expect(await within(drawer).findByRole("alert")).toHaveTextContent("no longer on this wedding");
    await waitFor(() =>
      expect(within(rowOf("Book venue")).getByText("Needs an owner")).toBeVisible(),
    );
    expect(within(rowOf("Book venue")).queryByText("@jo")).not.toBeInTheDocument();
    expect(select.value).toBe("");
    await waitFor(() => expect(calls("/tasks")).toHaveLength(1));
    expect(calls("/hosts").length).toBeGreaterThan(hostReadsBefore);
  });
});
