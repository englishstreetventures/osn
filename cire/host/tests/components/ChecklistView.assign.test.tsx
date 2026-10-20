// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Who holds each task, and the drawer that changes it, over a stubbed API.

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import ChecklistView from "../../src/components/ChecklistView";
import { __resetHostsCache, ensureHostsLoaded, type HostSeat } from "../../src/lib/hosts-store";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../../src/lib/tasks-store";
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

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
/** OSN could resolve neither a name nor a handle for this one. */
const ANON: HostSeat = { hostId: "whost_anon", osnProfileId: "usr_anon", role: "viewer" };

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** The API, by path: the hosts list, the task list, and the assignee write. */
function api(routes: { hosts?: Route; tasks?: Route; assign?: Route }) {
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
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

/** A response the test hands over when it chooses. */
function held() {
  let answer: (res: Response) => void = () => {};
  const route: Route = () => new Promise<Response>((resolve) => (answer = resolve));
  return { route, answer: (res: Response) => answer(res) };
}

const calls = (suffix: string, method = "GET") =>
  authFetchMock.mock.calls.filter(
    ([url, init]) =>
      new URL(String(url), "https://api.test").pathname.endsWith(suffix) &&
      ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );

/** A task's row on the checklist, by its checkbox — the drawer names the task too. */
const rowOf = (title: string) => screen.getByRole("checkbox", { name: title }).closest("li")!;

/** Open a task's drawer. */
async function openDrawer(title: string) {
  fireEvent.click(screen.getByRole("button", { name: `Edit ${title}` }));
  const drawer = await screen.findByRole("dialog", { name: "Edit task" });
  const select = (await within(drawer).findByLabelText("Assigned to")) as HTMLSelectElement;
  return { drawer, select };
}

const selectedOption = (select: HTMLSelectElement) =>
  select.options[select.selectedIndex]?.textContent ?? null;

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
});

beforeEach(() => {
  __resetTasksCache();
  __resetHostsCache();
});

describe("who holds a task", () => {
  it("names each assignee once the seats arrive — display name, else handle, else profile id — for a viewer too", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assignedHostId: "whost_sam" }),
      row({ id: "b", title: "Carry the rings", assignedHostId: "whost_jo", sortOrder: 1 }),
      row({ id: "c", title: "Mind the cake", assignedHostId: "whost_anon", sortOrder: 2 }),
    ]);
    const seats = held();
    api({ hosts: seats.route });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);

    // Until the seats answer there is no name to give, only the fact.
    await waitFor(() => expect(within(rowOf("Book venue")).getByText("Assigned")).toBeVisible());
    seats.answer(hostsAnswer([SAM, JO, ANON])());

    await waitFor(() => expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible());
    expect(within(rowOf("Carry the rings")).getByText("@jo")).toBeVisible();
    expect(within(rowOf("Mind the cake")).getByText("usr_anon")).toBeVisible();
    expect(within(rowOf("Book venue")).queryByText("Assigned")).not.toBeInTheDocument();
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

  it("treats a seat that has gone as nobody, on the row and in the drawer", async () => {
    // The server cleared the assignment when the seat went; this list is older.
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue", assignedHostId: "whost_gone" })]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() =>
      expect(within(rowOf("Book venue")).getByText("Needs an owner")).toBeVisible(),
    );

    const { select } = await openDrawer("Book venue");
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(selectedOption(select)).toBe("Nobody yet");
  });

  it("asks for nobody's names while no task is assigned", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({});
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Needs an owner");
    expect(authFetchMock).not.toHaveBeenCalled();
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
  it("assigns and unassigns from the drawer, and the row takes the task as stored", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assignedHostId: "whost_sam" }),
      row({ id: "b", title: "Carry the rings", timeframeBucket: "day_of", sortOrder: 1 }),
    ]);
    const assigned: unknown[] = [];
    api({
      hosts: hostsAnswer([SAM, JO]),
      assign: (init) => {
        const body = JSON.parse(String(init?.body)) as { assignedHostId: string | null };
        assigned.push(body);
        // The answer is the task as stored, which another co-host may have
        // dated in the meantime.
        return json({
          task: row({
            id: "b",
            title: "Carry the rings",
            timeframeBucket: "day_of",
            dueAt: "2027-06-05",
            ...body,
          }),
        });
      },
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() => expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible());

    const { drawer, select } = await openDrawer("Carry the rings");
    expect(within(drawer).getByText("Day of")).toBeVisible();
    expect(within(select).getByRole("option", { name: "Sam Lee · Owner" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "@jo · Helper" })).toBeTruthy();
    expect(selectedOption(select)).toBe("Nobody yet");

    fireEvent.change(select, { target: { value: "whost_jo" } });
    await waitFor(() => expect(assigned).toEqual([{ assignedHostId: "whost_jo" }]));
    const [url, init] = calls("/assignee", "PUT")[0]!;
    expect(new URL(String(url), "https://api.test").pathname).toBe(
      "/api/organiser/weddings/wed_1/tasks/b/assignee",
    );
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "application/json" });
    await waitFor(() => expect(within(rowOf("Carry the rings")).getByText("@jo")).toBeVisible());
    expect(within(rowOf("Carry the rings")).queryByText("Needs an owner")).not.toBeInTheDocument();
    // The row takes the stored task from the answer.
    await waitFor(() =>
      expect(within(rowOf("Carry the rings")).getByText(/due 2027-06-05/)).toBeVisible(),
    );
    // Only the task picked for changed hands.
    expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible();

    // The next pick waits for the first write to come back.
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(assigned).toEqual([{ assignedHostId: "whost_jo" }, { assignedHostId: null }]),
    );
    await waitFor(() =>
      expect(within(rowOf("Carry the rings")).getByText("Needs an owner")).toBeVisible(),
    );

    fireEvent.click(within(drawer).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(drawer).not.toHaveAttribute("open"));
  });

  it("sends one write at a time, holding the select until the answer", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    const write = held();
    api({ hosts: hostsAnswer([SAM, JO]), assign: write.route });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    const { select } = await openDrawer("Book venue");
    await waitFor(() => expect(select).not.toBeDisabled());

    fireEvent.change(select, { target: { value: "whost_jo" } });
    await waitFor(() => expect(select).toBeDisabled());
    fireEvent.change(select, { target: { value: "whost_sam" } });
    expect(calls("/assignee", "PUT")).toHaveLength(1);

    write.answer(json({ task: row({ id: "a", title: "Book venue", assignedHostId: "whost_jo" }) }));
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(within(rowOf("Book venue")).getByText("@jo")).toBeVisible();
  });

  it("takes the pick back at once and asks again when that person is no longer on the wedding", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    const reread = held();
    api({
      hosts: hostsAnswer([SAM, JO]),
      // Jo has gone; Sam has not.
      assign: (init) => {
        const { assignedHostId } = JSON.parse(String(init?.body)) as { assignedHostId: string };
        return assignedHostId === "whost_jo"
          ? json({ error: "assignee_not_in_wedding" }, 422)
          : json({ task: row({ id: "a", title: "Book venue", assignedHostId }) });
      },
      tasks: reread.route,
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    let { drawer, select } = await openDrawer("Book venue");
    await waitFor(() => expect(select).not.toBeDisabled());
    const hostReadsBefore = calls("/hosts").length;

    fireEvent.change(select, { target: { value: "whost_jo" } });

    expect(await within(drawer).findByRole("alert")).toHaveTextContent("no longer on this wedding");
    // Taken back before the re-read answers.
    expect(within(rowOf("Book venue")).getByText("Needs an owner")).toBeVisible();
    expect(within(rowOf("Book venue")).queryByText("@jo")).not.toBeInTheDocument();
    expect(select.value).toBe("");
    expect(calls("/tasks")).toHaveLength(1);
    expect(calls("/hosts").length).toBeGreaterThan(hostReadsBefore);
    reread.answer(json({ tasks: [row({ id: "a", title: "Book venue" })] }));

    // A fresh opening starts without the old refusal.
    fireEvent.click(within(drawer).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(drawer).not.toHaveAttribute("open"));
    ({ drawer, select } = await openDrawer("Book venue"));
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument();

    // And a pick that goes through clears one.
    fireEvent.change(select, { target: { value: "whost_jo" } });
    await within(drawer).findByRole("alert");
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: "whost_sam" } });
    await waitFor(() => expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument());
    expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible();
  });

  it("puts the previous holder back and says so when the write fails", async () => {
    const before = row({ id: "a", title: "Book venue", assignedHostId: "whost_sam" });
    setCachedTasks("wed_1", [before]);
    const reread = held();
    api({
      hosts: hostsAnswer([SAM, JO]),
      assign: () => json({ error: "Internal error" }, 500),
      tasks: reread.route,
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    const { drawer, select } = await openDrawer("Book venue");
    await waitFor(() => expect(select).not.toBeDisabled());

    fireEvent.change(select, { target: { value: "whost_jo" } });

    expect(await within(drawer).findByRole("alert")).toHaveTextContent(
      "Couldn't change who holds that task.",
    );
    // Put back before the re-read answers.
    expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible();
    expect(within(rowOf("Book venue")).queryByText("@jo")).not.toBeInTheDocument();
    expect(calls("/tasks")).toHaveLength(1);
    reread.answer(json({ tasks: [before] }));
  });

  it("says so when the wedding's people can't be read, and clears it once they can", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    let reads = 0;
    api({
      hosts: () => {
        reads += 1;
        return reads === 1 ? json({ error: "Internal error" }, 500) : hostsAnswer([SAM, JO])();
      },
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");

    let { drawer, select } = await openDrawer("Book venue");
    expect(await within(drawer).findByRole("alert")).toHaveTextContent(
      "Couldn't load the people on this wedding",
    );
    expect(select).toBeDisabled();

    fireEvent.click(within(drawer).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(drawer).not.toHaveAttribute("open"));
    ({ drawer, select } = await openDrawer("Book venue"));
    await waitFor(() => expect(select).not.toBeDisabled());
    // The notice from the failed read was on screen; it goes once a read succeeds.
    await waitFor(() => expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("reading the people for the drawer", () => {
  const opened = async (title: string) => {
    const { drawer, select } = await openDrawer(title);
    await waitFor(() => expect(select).not.toBeDisabled());
    return drawer;
  };
  const close = async (drawer: HTMLElement) => {
    fireEvent.click(within(drawer).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(drawer).not.toHaveAttribute("open"));
  };

  it("reads them on the first opening, and answers every later opening from that read", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue" }),
      row({ id: "b", title: "Carry the rings", sortOrder: 1 }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    expect(calls("/hosts")).toHaveLength(0);

    let drawer = await opened("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
    await close(drawer);
    drawer = await opened("Book venue");
    await close(drawer);
    drawer = await opened("Carry the rings");
    expect(within(drawer).getByRole("option", { name: "@jo · Helper" })).toBeTruthy();
    expect(calls("/hosts")).toHaveLength(1);
  });

  it("reads them again on the first opening when they were cached before this visit", async () => {
    // Read on an earlier visit, or handed over by the co-host panel; Jo has
    // been seated since, in another session.
    await ensureHostsLoaded("wed_1", async () => [SAM]);
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue", assignedHostId: "whost_sam" })]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() => expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible());
    expect(calls("/hosts")).toHaveLength(0);

    let drawer = await opened("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
    expect(await within(drawer).findByRole("option", { name: "@jo · Helper" })).toBeTruthy();
    await close(drawer);
    drawer = await opened("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
  });

  it("does not read them again on opening when this visit has just read them", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue", assignedHostId: "whost_sam" })]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() => expect(within(rowOf("Book venue")).getByText("Sam Lee")).toBeVisible());
    expect(calls("/hosts")).toHaveLength(1);

    await opened("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
  });
});

describe("a signed-out organiser", () => {
  it("is sent to sign in when the seats read answers 401", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue", assignedHostId: "whost_sam" })]);
    api({ hosts: () => new Response(null, { status: 401 }) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });

  it("is sent to sign in when the write answers 401, or the session has expired", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    let writes = 0;
    api({
      hosts: hostsAnswer([SAM, JO]),
      assign: () => {
        writes += 1;
        if (writes === 1) return new Response(null, { status: 401 });
        throw new Error("AuthExpiredError");
      },
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    const { drawer, select } = await openDrawer("Book venue");
    await waitFor(() => expect(select).not.toBeDisabled());

    fireEvent.change(select, { target: { value: "whost_jo" } });
    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: "whost_sam" } });
    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(2));
    expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is sent to sign in when the seats read finds the session expired", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({
      hosts: () => {
        throw new Error("AuthExpiredError");
      },
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    const { drawer } = await openDrawer("Book venue");
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument();
  });
});
