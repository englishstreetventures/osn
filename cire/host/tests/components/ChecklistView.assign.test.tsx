// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Who holds each task — the avatar stack on its row — and the popover that
// puts people on it and takes them off, over a stubbed API.

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

const { haptic } = vi.hoisted(() => ({ haptic: vi.fn() }));
vi.mock("../../src/lib/haptics", () => ({ haptic }));

import ChecklistView from "../../src/components/ChecklistView";
import {
  __resetHostsCache,
  ensureHostsLoaded,
  type HostSeat,
  setFreshHosts,
} from "../../src/lib/hosts-store";
import {
  __resetTasksCache,
  dropTasks,
  setCachedTasks,
  type TaskRow,
} from "../../src/lib/tasks-store";
import { authFetchMock, redirectSpy, resetOrganiserMocks, toastError } from "../test-support/mocks";

// happy-dom computes `animation-name` as "" rather than "none" for an element
// no rule animates, and Kobalte's presence then waits on an `animationend`
// that never comes: a closed popover would never leave the page. A real
// engine answers "none"; this says the same.
const noAnimations = document.createElement("style");
noAnimations.textContent = "* { animation-name: none; }";
document.head.append(noAnimations);

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

const SAM: HostSeat = {
  hostId: "whost_sam",
  osnProfileId: "usr_sam",
  handle: "sam",
  displayName: "Sam Lee",
  avatarUrl: "https://photos.example/sam.jpg",
  role: "owner",
};
const JO: HostSeat = { hostId: "whost_jo", osnProfileId: "usr_jo", handle: "jo", role: "helper" };
/** OSN could resolve neither a name nor a handle for this one. */
const ANON: HostSeat = { hostId: "whost_anon", osnProfileId: "usr_anon", role: "viewer" };
const KIM: HostSeat = {
  hostId: "whost_kim",
  osnProfileId: "usr_kim",
  handle: "kimmy",
  displayName: "Kim Park",
  role: "editor",
};
const ROBIN: HostSeat = {
  hostId: "whost_robin",
  osnProfileId: "usr_robin",
  handle: "rh",
  displayName: "Robin Hart",
  role: "viewer",
};
const ALEX: HostSeat = {
  hostId: "whost_alex",
  osnProfileId: "usr_alex",
  handle: "alex",
  displayName: "Alex Moore",
  role: "editor",
};

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;
interface HolderWrite {
  method: "PUT" | "DELETE";
  taskId: string;
  hostId: string;
}
type HolderRoute = (write: HolderWrite) => Response | Promise<Response>;

const HOLDER_PATH = /\/tasks\/([^/]+)\/assignees\/([^/]+)$/;

/** The API, by path: the seats, the task list, and the holder writes. */
function api(routes: { hosts?: Route; tasks?: Route; holder?: HolderRoute }) {
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://api.test").pathname;
    const holder = HOLDER_PATH.exec(path);
    if (holder && routes.holder) {
      return routes.holder({
        method: (init?.method ?? "GET") as "PUT" | "DELETE",
        taskId: decodeURIComponent(holder[1]!),
        hostId: decodeURIComponent(holder[2]!),
      });
    }
    if (path.endsWith("/hosts") && routes.hosts) return routes.hosts(init);
    if (path.endsWith("/tasks") && routes.tasks) return routes.tasks(init);
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hostsAnswer = (hosts: HostSeat[]) => () =>
  json({ hosts, total: hosts.length, peopleLimit: null });
/** A holder write's answer: the task as it stands, held by these seats. */
const stored = (assigneeHostIds: string[], over: Partial<TaskRow> = {}) =>
  json({ task: row({ id: "a", title: "Book venue", assigneeHostIds, ...over }) });

/** A response the test hands over when it chooses. */
function held() {
  let answer: (res: Response) => void = () => {};
  const route: Route = () => new Promise<Response>((resolve) => (answer = resolve));
  return { route, answer: (res: Response) => answer(res) };
}

/** Responses the test hands over one by one, by the order the requests came in. */
function heldEach() {
  const answers: ((res: Response | Promise<Response>) => void)[] = [];
  const route: HolderRoute = () => new Promise<Response>((resolve) => answers.push(resolve));
  return { route, answer: (k: number, res: Response | Promise<Response>) => answers[k]!(res) };
}

const calls = (suffix: string, method = "GET") =>
  authFetchMock.mock.calls.filter(
    ([url, init]) =>
      new URL(String(url), "https://api.test").pathname.endsWith(suffix) &&
      ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );

/** Every holder write sent, in order, as `METHOD task seat`. */
const sent = () =>
  authFetchMock.mock.calls.flatMap(([url, init]) => {
    const holder = HOLDER_PATH.exec(new URL(String(url), "https://api.test").pathname);
    return holder ? [`${(init as RequestInit).method} ${holder[1]} ${holder[2]}`] : [];
  });

/** A task's row on the checklist, by its checkbox. */
const rowOf = (title: string) => screen.getByRole("checkbox", { name: title }).closest("li")!;
/** What the row says about who holds it, in words. */
const heldBy = (title: string) => within(rowOf(title)).queryByText(/^Held by/)?.textContent ?? null;
/** The faces on the row's stack, left to right, by seat. */
const faces = (title: string) =>
  [...rowOf(title).querySelectorAll("[data-holder]")].map((el) => el.getAttribute("data-holder"));
/** The "+N" bubble after the faces, if there is one. */
const more = (title: string) => rowOf(title).querySelector("[data-more]")?.textContent ?? null;
const face = (title: string, hostId: string) =>
  rowOf(title).querySelector<HTMLElement>(`[data-holder="${hostId}"]`)!;
const assignButton = (title: string) =>
  screen.getByRole("button", { name: `Assign people to ${title}` });

/** Open a task's popover and wait for its people. */
async function openPopover(title: string) {
  fireEvent.click(assignButton(title));
  const dialog = await screen.findByRole("dialog", { name: "Assign people" });
  const listbox = within(dialog).getByRole("listbox", { name: "People" });
  await waitFor(() => expect(within(listbox).queryAllByRole("option").length).toBeGreaterThan(0));
  return { dialog, listbox };
}

const option = (listbox: HTMLElement, name: string) =>
  within(listbox).getByRole("option", { name: new RegExp(`^${name}`) });
/** The person the keyboard highlight is on, by what `box` names as active. */
const activeName = (box: HTMLElement, listbox: HTMLElement) => {
  const id = box.getAttribute("aria-activedescendant");
  return id
    ? listbox.querySelector(`[id="${id}"]`)?.querySelector("[data-name]")?.textContent
    : null;
};
/** Everyone the popover lists, top to bottom. */
const listed = (listbox: HTMLElement) =>
  within(listbox)
    .queryAllByRole("option")
    .map((o) => o.querySelector("[data-name]")?.textContent);

/** The people ticked in the popover, top to bottom. */
const ticked = (listbox: HTMLElement) =>
  within(listbox)
    .getAllByRole("option")
    .filter((o) => o.getAttribute("aria-selected") === "true")
    .map((o) => o.querySelector("[data-name]")?.textContent);

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  haptic.mockReset();
});

beforeEach(() => {
  __resetTasksCache();
  __resetHostsCache();
});

describe("who holds a task", () => {
  it("names every holder once the seats arrive — display name, else handle, else profile id — for a viewer too", async () => {
    setCachedTasks("wed_1", [
      row({
        id: "a",
        title: "Book venue",
        assigneeHostIds: ["whost_sam", "whost_jo", "whost_anon"],
      }),
      row({ id: "b", title: "Carry the rings", assigneeHostIds: ["whost_jo"], sortOrder: 1 }),
      row({
        id: "c",
        title: "Mind the cake",
        assigneeHostIds: ["whost_sam", "whost_jo", "whost_anon", "whost_kim", "whost_robin"],
        sortOrder: 2,
      }),
    ]);
    const seats = held();
    api({ hosts: seats.route });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);

    // Until the seats answer there are no names to give, only how many.
    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by 3 people"));
    expect(heldBy("Carry the rings")).toBe("Held by 1 person");
    expect(faces("Book venue")).toEqual(["whost_sam", "whost_jo", "whost_anon"]);
    expect(face("Book venue", "whost_sam")).not.toHaveAttribute("title");
    expect(rowOf("Mind the cake").querySelector("[data-more]")).toHaveAttribute("title", "");
    seats.answer(hostsAnswer([SAM, JO, ANON])());

    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by Sam Lee, @jo and usr_anon"));
    expect(heldBy("Carry the rings")).toBe("Held by @jo");
    expect(calls("/hosts")).toHaveLength(1);
  });

  it("puts the reader first when they hold the task, then everyone in the order they were added", async () => {
    api({
      hosts: hostsAnswer([SAM, JO, ANON]),
      tasks: () =>
        json({
          tasks: [
            row({
              id: "a",
              title: "Book venue",
              assigneeHostIds: ["whost_jo", "whost_sam", "whost_anon"],
            }),
            row({
              id: "b",
              title: "Carry the rings",
              assigneeHostIds: ["whost_sam", "whost_jo"],
              sortOrder: 1,
            }),
          ],
          viewerHostId: "whost_anon",
        }),
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);

    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by usr_anon, @jo and Sam Lee"));
    expect(faces("Book venue")).toEqual(["whost_anon", "whost_jo", "whost_sam"]);
    expect(faces("Carry the rings")).toEqual(["whost_sam", "whost_jo"]);
  });

  it("shows three faces and counts the rest", async () => {
    setCachedTasks("wed_1", [
      row({
        id: "a",
        title: "Book venue",
        assigneeHostIds: ["whost_sam", "whost_jo", "whost_anon", "whost_kim", "whost_robin"],
      }),
      row({
        id: "b",
        title: "Carry the rings",
        assigneeHostIds: ["whost_sam", "whost_jo", "whost_anon"],
        sortOrder: 1,
      }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO, ANON, KIM, ROBIN]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);

    await waitFor(() =>
      expect(heldBy("Book venue")).toBe("Held by Sam Lee, @jo, usr_anon, Kim Park and Robin Hart"),
    );
    expect(faces("Book venue")).toEqual(["whost_sam", "whost_jo", "whost_anon"]);
    expect(more("Book venue")).toBe("+2");
    // Each name on hover: a face's own, and the count's everyone it stands for.
    expect(face("Book venue", "whost_sam")).toHaveAttribute("title", "Sam Lee");
    expect(rowOf("Book venue").querySelector("[data-more]")).toHaveAttribute(
      "title",
      "Kim Park, Robin Hart",
    );
    expect(faces("Carry the rings")).toEqual(["whost_sam", "whost_jo", "whost_anon"]);
    expect(more("Carry the rings")).toBeNull();
  });

  it("gives an owner or editor the + as the last layer of every row, held or not, open or done", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue" }),
      row({ id: "b", title: "Pick a date", status: "done", completedAt: 2, sortOrder: 1 }),
      row({
        id: "c",
        title: "Carry the rings",
        assigneeHostIds: ["whost_sam", "whost_jo"],
        sortOrder: 2,
      }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() => expect(heldBy("Carry the rings")).toBe("Held by Sam Lee and @jo"));

    expect(
      ["Book venue", "Pick a date", "Carry the rings"].map((title) =>
        assignButton(title).lastElementChild?.hasAttribute("data-assign-plus"),
      ),
    ).toEqual([true, true, true]);
    expect(assignButton("Book venue").querySelectorAll("[data-holder]")).toHaveLength(0);
    expect(assignButton("Carry the rings").querySelectorAll("[data-holder]")).toHaveLength(2);
    expect(screen.queryByRole("img", { name: "Nobody assigned yet" })).not.toBeInTheDocument();
  });

  it("shows a viewer an empty circle only on an open task nobody holds, and no way to assign", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue" }),
      row({ id: "b", title: "Pick a date", status: "done", completedAt: 2, sortOrder: 1 }),
      row({ id: "c", title: "Carry the rings", assigneeHostIds: ["whost_jo"], sortOrder: 2 }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await waitFor(() => expect(heldBy("Carry the rings")).toBe("Held by @jo"));

    const empty = within(rowOf("Book venue")).getByRole("img", { name: "Nobody assigned yet" });
    expect(empty).not.toHaveAttribute("data-assign-plus");
    expect(empty.querySelector("svg")).toBeNull();
    expect(within(rowOf("Pick a date")).queryByRole("img")).not.toBeInTheDocument();
    expect(faces("Pick a date")).toEqual([]);
    expect(within(rowOf("Carry the rings")).queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Assign people/ })).not.toBeInTheDocument();
    expect(document.querySelector("[data-assign-plus]")).toBeNull();
  });

  it("leaves a seat that has gone off the stack", async () => {
    // The server took the seat off its tasks when it went; this list is older.
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_gone", "whost_sam"] }),
      row({ id: "b", title: "Carry the rings", assigneeHostIds: ["whost_gone"], sortOrder: 1 }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);

    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by Sam Lee"));
    expect(faces("Book venue")).toEqual(["whost_sam"]);
    expect(faces("Carry the rings")).toEqual([]);
    expect(heldBy("Carry the rings")).toBeNull();
    expect(
      within(rowOf("Carry the rings")).getByRole("img", { name: "Nobody assigned yet" }),
    ).toBeVisible();
  });

  it("asks for nobody's names while no task is held, until the popover opens", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    expect(authFetchMock).not.toHaveBeenCalled();

    await openPopover("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
  });
});

describe("a holder's face", () => {
  const silhouette = (el: HTMLElement) => el.querySelector("[data-blank-avatar]");

  it("is the photo when there is one, and the empty avatar when there is none or it is not https", async () => {
    const PLAIN: HostSeat = { ...ANON, avatarUrl: "http://photos.example/anon.jpg" };
    const GARBLED: HostSeat = { ...KIM, avatarUrl: "not a url" };
    setCachedTasks("wed_1", [
      row({
        id: "a",
        title: "Book venue",
        assigneeHostIds: ["whost_sam", "whost_jo", "whost_anon"],
      }),
      row({ id: "b", title: "Carry the rings", assigneeHostIds: ["whost_kim"], sortOrder: 1 }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO, PLAIN, GARBLED]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await waitFor(() => expect(heldBy("Book venue")).toMatch(/Sam Lee/));

    const photo = face("Book venue", "whost_sam").querySelector("img")!;
    expect(photo).toHaveAttribute("src", "https://photos.example/sam.jpg");
    expect(photo).toHaveAttribute("alt", "");
    // The photo's host learns who loaded it from their IP address; it is not
    // told which wedding's page they were on.
    expect(photo).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(silhouette(face("Book venue", "whost_sam"))).toBeNull();
    expect(silhouette(face("Book venue", "whost_jo"))).not.toBeNull();
    expect(face("Book venue", "whost_jo").querySelector("img")).toBeNull();
    expect(face("Book venue", "whost_anon").querySelector("img")).toBeNull();
    expect(silhouette(face("Book venue", "whost_anon"))).not.toBeNull();
    expect(face("Carry the rings", "whost_kim").querySelector("img")).toBeNull();
    expect(silhouette(face("Carry the rings", "whost_kim"))).not.toBeNull();
  });

  it("falls back to the empty avatar when the photo will not load, and tries a new photo again", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] }),
    ]);
    api({ hosts: hostsAnswer([SAM]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by Sam Lee"));

    fireEvent.error(face("Book venue", "whost_sam").querySelector("img")!);
    await waitFor(() => expect(silhouette(face("Book venue", "whost_sam"))).not.toBeNull());
    expect(face("Book venue", "whost_sam").querySelector("img")).toBeNull();

    // Sam changes their photo; the co-host panel's read brings the new one.
    setFreshHosts("wed_1", [{ ...SAM, avatarUrl: "https://photos.example/sam-2.jpg" }]);
    await waitFor(() =>
      expect(face("Book venue", "whost_sam").querySelector("img")).toHaveAttribute(
        "src",
        "https://photos.example/sam-2.jpg",
      ),
    );
  });
});

describe("the popover", () => {
  it("puts a person on and takes them off at once, and stays open over the same trigger", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] }),
      row({ id: "b", title: "Carry the rings", timeframeBucket: "day_of", sortOrder: 1 }),
    ]);
    const writes: HolderWrite[] = [];
    api({
      hosts: hostsAnswer([SAM, JO, KIM]),
      holder: (write) => {
        writes.push(write);
        // The answer is the task as stored, which another co-host has put
        // Kim on in the meantime.
        return json({
          task: row({
            id: "b",
            title: "Carry the rings",
            timeframeBucket: "day_of",
            sortOrder: 1,
            assigneeHostIds: write.method === "PUT" ? ["whost_kim", "whost_jo"] : ["whost_kim"],
          }),
        });
      },
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by Sam Lee"));
    const trigger = assignButton("Carry the rings");

    const { dialog, listbox } = await openPopover("Carry the rings");
    expect(listbox).toHaveAttribute("aria-multiselectable", "true");
    expect(ticked(listbox)).toEqual([]);
    expect(option(listbox, "Sam Lee")).toHaveTextContent("Owner");
    expect(option(listbox, "@jo")).toHaveTextContent("Helper");

    const hostReads = calls("/hosts").length;
    fireEvent.click(option(listbox, "@jo"));
    // Shown before the server answers, with the tap the portal gives a commit.
    expect(ticked(listbox)).toEqual(["@jo"]);
    expect(haptic).toHaveBeenLastCalledWith("commit");
    expect(faces("Carry the rings")).toContain("whost_jo");
    await waitFor(() => expect(writes).toHaveLength(1));
    const [url, init] = calls("/assignees/whost_jo", "PUT")[0]!;
    expect(new URL(String(url), "https://api.test").pathname).toBe(
      "/api/organiser/weddings/wed_1/tasks/b/assignees/whost_jo",
    );
    expect((init as RequestInit).body).toBeUndefined();
    // The row takes the holders the server answered with, Kim included.
    await waitFor(() => expect(faces("Carry the rings")).toEqual(["whost_kim", "whost_jo"]));
    expect(faces("Book venue")).toEqual(["whost_sam"]);

    fireEvent.click(option(listbox, "@jo"));
    expect(ticked(listbox)).toEqual(["Kim Park"]);
    await waitFor(() => expect(writes.map((w) => w.method)).toEqual(["PUT", "DELETE"]));
    expect(writes[1]).toEqual({ method: "DELETE", taskId: "b", hostId: "whost_jo" });
    await waitFor(() => expect(faces("Carry the rings")).toEqual(["whost_kim"]));

    // A stored write reads nobody's names again.
    expect(calls("/hosts")).toHaveLength(hostReads);
    // Still open, over the same trigger: no toggle rebuilt the row.
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Assign people" })).toBe(dialog);
    expect(assignButton("Carry the rings")).toBe(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("ticks a person's circle while they hold the task, and clears it when they do not", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]), holder: () => stored(["whost_sam", "whost_jo"]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");

    const circle = (name: string) => option(listbox, name).querySelector("[data-toggle]")!;
    expect(option(listbox, "Sam Lee")).toHaveAttribute("aria-selected", "true");
    expect(circle("Sam Lee")).toHaveAttribute("data-on");
    expect(circle("Sam Lee").querySelector("[data-tick]")).not.toBeNull();
    expect(option(listbox, "@jo")).toHaveAttribute("aria-selected", "false");
    expect(circle("@jo")).not.toHaveAttribute("data-on");
    expect(circle("@jo").querySelector("[data-tick]")).toBeNull();

    fireEvent.click(option(listbox, "@jo"));
    expect(circle("@jo")).toHaveAttribute("data-on");
    expect(circle("@jo").querySelector("[data-tick]")).not.toBeNull();
  });

  it("offers a seat whose role this portal does not know as a helper, and puts them on", async () => {
    // The API and the portal deploy apart, so a newer API can name a role this
    // build has never shipped.
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    const PAT = { hostId: "whost_pat", osnProfileId: "usr_pat", handle: "pat", role: "planner" };
    api({
      hosts: () => json({ hosts: [PAT], total: 1, peopleLimit: null }),
      holder: () => stored(["whost_pat"]),
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");

    expect(option(listbox, "@pat")).toHaveTextContent("Helper");
    fireEvent.click(option(listbox, "@pat"));
    await waitFor(() => expect(sent()).toEqual(["PUT a whost_pat"]));
    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by @pat"));
  });

  it("lists the reader first, and says it is them", async () => {
    api({
      hosts: hostsAnswer([SAM, JO, ANON]),
      tasks: () =>
        json({ tasks: [row({ id: "a", title: "Book venue" })], viewerHostId: "whost_jo" }),
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    const { listbox } = await openPopover("Book venue");

    const names = within(listbox)
      .getAllByRole("option")
      .map((o) => o.querySelector("[data-name]")?.textContent);
    expect(names).toEqual(["@jo", "Sam Lee", "usr_anon"]);
    expect(option(listbox, "@jo")).toHaveTextContent("You · Helper");
    expect(option(listbox, "Sam Lee")).not.toHaveTextContent("You");
  });

  it("offers no search for five people, and a search over names and handles for six", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    const five = [SAM, JO, ANON, KIM, ROBIN];
    let seats = five;
    api({ hosts: () => hostsAnswer(seats)() });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);

    let { dialog, listbox } = await openPopover("Book venue");
    expect(within(listbox).getAllByRole("option")).toHaveLength(5);
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Nobody matches/)).not.toBeInTheDocument();
    fireEvent.keyDown(listbox, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    // A sixth is seated; the co-host panel marks the seats stale.
    seats = [...five, ALEX];
    setFreshHosts("wed_1", seats);
    ({ dialog, listbox } = await openPopover("Book venue"));
    let search = within(dialog).getByRole("combobox", { name: "Search people" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(6);
    expect(search).toHaveAttribute("spellcheck", "false");
    expect(within(dialog).queryByText(/^Nobody matches/)).not.toBeInTheDocument();

    fireEvent.input(search, { target: { value: "  @KIMMY " } });
    expect(listed(listbox)).toEqual(["Kim Park"]);
    fireEvent.input(search, { target: { value: "hart" } });
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.querySelector("[data-name]")?.textContent),
    ).toEqual(["Robin Hart"]);
    fireEvent.input(search, { target: { value: "KIMMY" } });
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.querySelector("[data-name]")?.textContent),
    ).toEqual(["Kim Park"]);
    // A search left behind when the people drop to five filters nothing.
    fireEvent.input(search, { target: { value: "kimmy" } });
    expect(listed(listbox)).toEqual(["Kim Park"]);
    setFreshHosts("wed_1", five);
    await waitFor(() => expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument());
    expect(listed(listbox)).toHaveLength(5);
    setFreshHosts("wed_1", seats);
    search = await within(dialog).findByRole("combobox", { name: "Search people" });

    fireEvent.input(search, { target: { value: "zz" } });
    expect(within(listbox).queryAllByRole("option")).toHaveLength(0);
    expect(within(dialog).getByText("Nobody matches “zz”.")).toBeVisible();
    // Nothing to point at, and nothing to toggle.
    expect(search).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(sent()).toEqual([]);
  });

  it("takes a person back at once and reads the seats and tasks again when they are no longer on the wedding", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    const reread = held();
    api({
      hosts: hostsAnswer([SAM, JO]),
      // Jo has gone; Sam has not.
      holder: ({ hostId }) =>
        hostId === "whost_jo" ? json({ error: "assignee_not_in_wedding" }, 422) : stored([hostId]),
      tasks: reread.route,
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");
    const hostReadsBefore = calls("/hosts").length;

    fireEvent.click(option(listbox, "@jo"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "That person is no longer on this wedding. Pick someone else.",
      ),
    );
    // Taken back before the re-read answers.
    expect(ticked(listbox)).toEqual([]);
    expect(faces("Book venue")).toEqual([]);
    expect(calls("/tasks")).toHaveLength(1);
    await waitFor(() => expect(calls("/hosts").length).toBeGreaterThan(hostReadsBefore));
    reread.answer(json({ tasks: [row({ id: "a", title: "Book venue" })] }));

    fireEvent.click(option(listbox, "Sam Lee"));
    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by Sam Lee"));
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("takes a person back and says so when the write fails", async () => {
    const before = row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] });
    setCachedTasks("wed_1", [before]);
    const reread = held();
    api({
      hosts: hostsAnswer([SAM, JO]),
      holder: () => json({ error: "Internal error" }, 500),
      tasks: reread.route,
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");

    fireEvent.click(option(listbox, "@jo"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't change who holds that task."),
    );
    // Put back before the re-read answers.
    expect(ticked(listbox)).toEqual(["Sam Lee"]);
    expect(faces("Book venue")).toEqual(["whost_sam"]);
    expect(calls("/tasks")).toHaveLength(1);
    expect(haptic).toHaveBeenLastCalledWith("reject");
    // A failure is not a seat gone: the people are not read again.
    expect(calls("/hosts")).toHaveLength(1);
    reread.answer(json({ tasks: [before] }));
  });

  it("takes a person back and says so when the write never reaches the server", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({
      hosts: hostsAnswer([SAM, JO]),
      holder: () => {
        throw new TypeError("Failed to fetch");
      },
      tasks: () => json({ tasks: [row({ id: "a", title: "Book venue" })] }),
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");

    fireEvent.click(option(listbox, "@jo"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't change who holds that task."),
    );
    expect(ticked(listbox)).toEqual([]);
    expect(redirectSpy).not.toHaveBeenCalled();
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

    fireEvent.click(assignButton("Book venue"));
    let dialog = await screen.findByRole("dialog", { name: "Assign people" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Couldn't load the people on this wedding",
    );
    expect(within(dialog).queryAllByRole("option")).toHaveLength(0);

    fireEvent.keyDown(within(dialog).getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    // Closing asks for nothing; opening again does.
    expect(reads).toBe(1);
    ({ dialog } = await openPopover("Book venue"));
    expect(reads).toBe(2);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops the notice when the co-host panel hands over the people", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({ hosts: () => json({ error: "Internal error" }, 500) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    fireEvent.click(assignButton("Book venue"));
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    await within(dialog).findByRole("alert");

    setFreshHosts("wed_1", [SAM, JO]);
    await within(dialog).findAllByRole("option");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says it is looking, not that it failed, while it asks again for the people", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    const retry = held();
    let reads = 0;
    api({
      hosts: (init) => {
        reads += 1;
        return reads === 1 ? json({ error: "Internal error" }, 500) : retry.route(init);
      },
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    fireEvent.click(assignButton("Book venue"));
    let dialog = await screen.findByRole("dialog", { name: "Assign people" });
    await within(dialog).findByRole("alert");
    fireEvent.keyDown(within(dialog).getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    fireEvent.click(assignButton("Book venue"));
    dialog = await screen.findByRole("dialog", { name: "Assign people" });
    await waitFor(() => expect(reads).toBe(2));
    expect(within(dialog).getByText("Finding the people on this wedding…")).toBeVisible();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    retry.answer(hostsAnswer([SAM, JO])());
    await within(dialog).findAllByRole("option");
  });
});

describe("reading the people for the popover", () => {
  const close = async (dialog: HTMLElement) => {
    fireEvent.keyDown(within(dialog).getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
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

    let { dialog } = await openPopover("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
    await close(dialog);
    ({ dialog } = await openPopover("Book venue"));
    await close(dialog);
    const { listbox } = await openPopover("Carry the rings");
    expect(option(listbox, "@jo")).toBeTruthy();
    expect(calls("/hosts")).toHaveLength(1);
  });

  it("reads them again on the first opening when they were cached before this visit", async () => {
    // Read on an earlier visit, or handed over by the co-host panel; Jo has
    // been seated since, in another session.
    await ensureHostsLoaded("wed_1", async () => [SAM]);
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by Sam Lee"));
    expect(calls("/hosts")).toHaveLength(0);

    const { dialog, listbox } = await openPopover("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
    await waitFor(() => expect(option(listbox, "@jo")).toBeTruthy());
    await close(dialog);
    await openPopover("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
  });

  it("does not read them again on opening when this visit has just read them", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] }),
    ]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await waitFor(() => expect(heldBy("Book venue")).toBe("Held by Sam Lee"));
    expect(calls("/hosts")).toHaveLength(1);

    await openPopover("Book venue");
    expect(calls("/hosts")).toHaveLength(1);
  });
});

describe("the popover from the keyboard", () => {
  it("moves through five people on the list itself, and toggles with Space and Enter", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({
      hosts: hostsAnswer([SAM, JO, ANON, KIM, ROBIN]),
      holder: ({ method, hostId }) => stored(method === "PUT" ? [hostId] : []),
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");
    await waitFor(() => expect(document.activeElement).toBe(listbox));

    expect(listbox.id).not.toBe("");
    expect(activeName(listbox, listbox)).toBe("Sam Lee");
    // Each key the list answers is taken from the page: none scrolls it.
    expect(fireEvent.keyDown(listbox, { key: "ArrowDown" })).toBe(false);
    expect(activeName(listbox, listbox)).toBe("@jo");
    expect(fireEvent.keyDown(listbox, { key: "ArrowUp" })).toBe(false);
    expect(activeName(listbox, listbox)).toBe("Sam Lee");
    expect(fireEvent.keyDown(listbox, { key: "End" })).toBe(false);
    expect(fireEvent.keyDown(listbox, { key: "Home" })).toBe(false);
    fireEvent.keyDown(listbox, { key: "End" });
    expect(activeName(listbox, listbox)).toBe("Robin Hart");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(activeName(listbox, listbox)).toBe("Sam Lee");
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(activeName(listbox, listbox)).toBe("Robin Hart");
    fireEvent.keyDown(listbox, { key: "Home" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(activeName(listbox, listbox)).toBe("@jo");

    expect(fireEvent.keyDown(listbox, { key: " " })).toBe(false);
    expect(ticked(listbox)).toEqual(["@jo"]);
    await waitFor(() => expect(sent()).toEqual(["PUT a whost_jo"]));
    expect(fireEvent.keyDown(listbox, { key: "Enter" })).toBe(false);
    expect(ticked(listbox)).toEqual([]);
    await waitFor(() => expect(sent()).toEqual(["PUT a whost_jo", "DELETE a whost_jo"]));
  });

  it("follows the pointer and the click with the highlight, so a key goes on from there", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({
      hosts: hostsAnswer([SAM, JO, ANON]),
      holder: ({ method, hostId }) => stored(method === "PUT" ? [hostId] : []),
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");

    fireEvent.pointerMove(option(listbox, "usr_anon"));
    expect(activeName(listbox, listbox)).toBe("usr_anon");
    // A click on a row keeps the focus where it is.
    expect(fireEvent.mouseDown(option(listbox, "@jo"))).toBe(false);
    fireEvent.click(option(listbox, "@jo"));
    expect(activeName(listbox, listbox)).toBe("@jo");
    await waitFor(() => expect(sent()).toEqual(["PUT a whost_jo"]));
    fireEvent.keyDown(listbox, { key: "Enter" });
    await waitFor(() => expect(sent()).toEqual(["PUT a whost_jo", "DELETE a whost_jo"]));
  });

  it("keeps the highlight on the list when the people re-read are fewer", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({ hosts: hostsAnswer([SAM, JO, ANON, KIM, ROBIN]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");
    fireEvent.keyDown(listbox, { key: "End" });
    expect(activeName(listbox, listbox)).toBe("Robin Hart");

    // Robin leaves; the co-host panel hands over the shorter list.
    setFreshHosts("wed_1", [SAM, JO, ANON, KIM]);
    await waitFor(() => expect(listed(listbox)).toHaveLength(4));
    expect(activeName(listbox, listbox)).toBe("Kim Park");
  });

  it("starts in the search for six people; Enter toggles and a space is typed", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({
      hosts: hostsAnswer([SAM, JO, ANON, KIM, ROBIN, ALEX]),
      holder: ({ hostId }) => stored([hostId]),
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { dialog, listbox } = await openPopover("Book venue");
    const search = within(dialog).getByRole("combobox", { name: "Search people" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(search).toHaveAttribute("aria-controls", listbox.id);

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(activeName(search, listbox)).toBe("@jo");
    const space = fireEvent.keyDown(search, { key: " " });
    expect(space).toBe(true);
    expect(sent()).toEqual([]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(ticked(listbox)).toEqual(["@jo"]);
    await waitFor(() => expect(sent()).toEqual(["PUT a whost_jo"]));

    // The highlight goes back to the top of what the search leaves.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(activeName(search, listbox)).toBe("usr_anon");
    fireEvent.input(search, { target: { value: "o" } });
    expect(activeName(search, listbox)).toBe(listed(listbox)[0]);
    fireEvent.input(search, { target: { value: "moore" } });
    expect(activeName(search, listbox)).toBe("Alex Moore");
  });

  it("moves into the search when the people arriving after it opened bring one", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    const seats = held();
    api({ hosts: seats.route });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    fireEvent.click(assignButton("Book venue"));
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    const listbox = within(dialog).getByRole("listbox", { name: "People" });
    await waitFor(() => expect(document.activeElement).toBe(listbox));
    expect(within(dialog).getByText("Finding the people on this wedding…")).toBeVisible();

    seats.answer(hostsAnswer([SAM, JO, ANON, KIM, ROBIN, ALEX])());
    const search = await within(dialog).findByRole("combobox", { name: "Search people" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(
      within(dialog).queryByText("Finding the people on this wedding…"),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["Escape", { key: "Escape" }],
    ["Tab", { key: "Tab" }],
    ["Shift+Tab", { key: "Tab", shiftKey: true }],
  ])("closes on %s and gives the focus back to the trigger", async (_, key) => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({ hosts: hostsAnswer([SAM, JO]) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { dialog, listbox } = await openPopover("Book venue");
    await waitFor(() => expect(document.activeElement).toBe(listbox));

    fireEvent.keyDown(listbox, key);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(assignButton("Book venue")));
  });
});

describe("people picked while a write is out", () => {
  async function popoverWithHeldWrites({
    tasks,
    holders = [],
  }: { tasks?: Route; holders?: string[] } = {}) {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue", assigneeHostIds: holders })]);
    const writes = heldEach();
    api({ hosts: hostsAnswer([SAM, JO]), holder: writes.route, tasks });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    await screen.findByText("Book venue");
    const { listbox } = await openPopover("Book venue");
    return { listbox, writes };
  }

  it("keeps every person usable while a write is out, and says the list is busy", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    expect(listbox).toHaveAttribute("aria-busy", "true");
    for (const o of within(listbox).getAllByRole("option")) {
      expect(o).not.toHaveAttribute("aria-disabled");
    }

    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));
  });

  it("writes a person's later pick once their write is back", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "@jo"));
    expect(sent()).toEqual(["PUT a whost_jo"]);

    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(sent()).toEqual(["PUT a whost_jo", "DELETE a whost_jo"]));
    writes.answer(1, stored([]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));
    expect(ticked(listbox)).toEqual([]);
    expect(faces("Book venue")).toEqual([]);
  });

  it("writes picks of different people at once, without waiting for each other", async () => {
    const { listbox } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Sam Lee"));
    expect(sent()).toEqual(["PUT a whost_jo", "PUT a whost_sam"]);
    expect(ticked(listbox)).toEqual(["Sam Lee", "@jo"]);
  });

  it("sends nothing more when a person's picks cancel out while their write is out", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "@jo"));
    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));
    expect(sent()).toEqual(["PUT a whost_jo"]);
    expect(ticked(listbox)).toEqual(["@jo"]);
  });

  it("keeps showing the latest pick when the earlier write answers", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "@jo"));
    expect(ticked(listbox)).toEqual([]);

    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(sent()).toHaveLength(2));
    // The first answer would put Jo back under a keyboard user mid-way through.
    expect(ticked(listbox)).toEqual([]);
    expect(faces("Book venue")).toEqual([]);
    writes.answer(1, stored([]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));
    expect(ticked(listbox)).toEqual([]);
  });

  it("lets the later pick decide when a write it replaced is refused", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "@jo"));
    writes.answer(0, json({ error: "Internal error" }, 500));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));

    expect(toastError).not.toHaveBeenCalled();
    expect(ticked(listbox)).toEqual([]);
    // Jo is not on the task, which is what the later pick asked for.
    expect(sent()).toEqual(["PUT a whost_jo"]);
    expect(calls("/tasks")).toHaveLength(0);
    // Nothing of the pick is left over the list: a read that finds Jo put on
    // by someone else shows Jo.
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_jo"] })]);
    expect(ticked(listbox)).toEqual(["@jo"]);
  });

  it("puts back what the server last said when the last write of a run fails", async () => {
    const reread = held();
    const { listbox, writes } = await popoverWithHeldWrites({ tasks: reread.route });

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "@jo"));
    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(sent()).toHaveLength(2));
    writes.answer(1, json({ error: "Internal error" }, 500));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't change who holds that task."),
    );
    // Jo, whom the first write stored — not nobody, as before the picks.
    expect(ticked(listbox)).toEqual(["@jo"]);
    expect(faces("Book venue")).toEqual(["whost_jo"]);
    reread.answer(
      json({ tasks: [row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_jo"] })] }),
    );
  });

  it("takes back each refused person, and only them", async () => {
    const reread = held();
    const { listbox, writes } = await popoverWithHeldWrites({
      tasks: reread.route,
      holders: ["whost_sam"],
    });

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Sam Lee"));
    expect(sent()).toEqual(["PUT a whost_jo", "DELETE a whost_sam"]);
    writes.answer(0, json({ error: "Internal error" }, 500));
    writes.answer(1, json({ error: "Internal error" }, 500));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
    expect(ticked(listbox)).toEqual(["Sam Lee"]);
    expect(faces("Book venue")).toEqual(["whost_sam"]);
    reread.answer(
      json({ tasks: [row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] })] }),
    );
  });

  it("keeps a person stored while another is refused", async () => {
    const reread = held();
    const { listbox, writes } = await popoverWithHeldWrites({ tasks: reread.route });

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Sam Lee"));
    writes.answer(0, stored(["whost_jo"]));
    writes.answer(1, json({ error: "Internal error" }, 500));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(ticked(listbox)).toEqual(["@jo"]);
    expect(faces("Book venue")).toEqual(["whost_jo"]);
    reread.answer(
      json({ tasks: [row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_jo"] })] }),
    );
  });

  it("keeps both people when their answers come back in the other order", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Sam Lee"));
    // The server stored Jo, then Sam; Sam's answer arrives first, and Jo's —
    // read before Sam was stored — after it.
    writes.answer(1, stored(["whost_jo", "whost_sam"]));
    await waitFor(() => expect(calls("/assignees/whost_sam", "PUT")).toHaveLength(1));
    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));

    expect(faces("Book venue")).toEqual(["whost_jo", "whost_sam"]);
    expect(ticked(listbox)).toEqual(["Sam Lee", "@jo"]);
  });

  it("keeps both people when the first answer already names the second", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Sam Lee"));
    // The server stored Sam, then Jo; Jo's answer arrives first.
    writes.answer(0, stored(["whost_sam", "whost_jo"]));
    await waitFor(() => expect(calls("/assignees/whost_jo", "PUT")).toHaveLength(1));
    writes.answer(1, stored(["whost_sam"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));

    expect(faces("Book venue")).toEqual(["whost_sam", "whost_jo"]);
  });

  it("takes a person off for good when that answer flew beside another", async () => {
    const { listbox, writes } = await popoverWithHeldWrites({ holders: ["whost_sam"] });

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Sam Lee"));
    expect(sent()).toEqual(["PUT a whost_jo", "DELETE a whost_sam"]);
    writes.answer(1, stored([]));
    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));

    expect(faces("Book venue")).toEqual(["whost_jo"]);
    expect(ticked(listbox)).toEqual(["@jo"]);
  });

  it("takes only its own person from an answer that flew beside another", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] }),
    ]);
    const writes = heldEach();
    api({ hosts: hostsAnswer([SAM, JO, KIM, ROBIN]), holder: writes.route });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Kim Park"));
    // Robin, put on by someone else, is in an answer that may be older than
    // what the list already holds: the next read brings Robin, not this one.
    writes.answer(0, stored(["whost_sam", "whost_robin", "whost_jo"]));
    await waitFor(() => expect(calls("/assignees/whost_jo", "PUT")).toHaveLength(1));
    writes.answer(1, stored(["whost_sam", "whost_robin", "whost_jo", "whost_kim"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));

    expect(faces("Book venue")).toEqual(["whost_sam", "whost_jo", "whost_kim"]);
  });

  it("says nothing when the task goes while its writes are out", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Sam Lee"));
    setCachedTasks("wed_1", []);
    writes.answer(0, stored(["whost_jo"]));
    writes.answer(1, stored(["whost_jo", "whost_sam"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says nothing when the checklist is put away while a write is out", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    dropTasks("wed_1");
    writes.answer(0, stored(["whost_jo"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("takes a later answer whole when its write flew alone", async () => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));
    // Someone else took Jo off and put Sam on in the meantime.
    fireEvent.click(option(listbox, "Sam Lee"));
    writes.answer(1, stored(["whost_sam"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));

    expect(faces("Book venue")).toEqual(["whost_sam"]);
  });

  it.each([
    [
      "answers 401",
      (writes: ReturnType<typeof heldEach>) =>
        writes.answer(0, new Response(null, { status: 401 })),
    ],
    [
      "finds the session expired",
      (writes: ReturnType<typeof heldEach>) =>
        writes.answer(0, Promise.reject(new Error("AuthExpiredError"))),
    ],
  ])("sends nothing more once a write %s", async (_, signOut) => {
    const { listbox, writes } = await popoverWithHeldWrites();

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "@jo"));
    signOut(writes);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));
    fireEvent.click(option(listbox, "Sam Lee"));
    expect(sent()).toEqual(["PUT a whost_jo"]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("puts back what a finished write stored when a later pick fails", async () => {
    const reread = held();
    const { listbox, writes } = await popoverWithHeldWrites({ tasks: reread.route });

    fireEvent.click(option(listbox, "@jo"));
    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));
    fireEvent.click(option(listbox, "@jo"));
    writes.answer(1, json({ error: "Internal error" }, 500));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(ticked(listbox)).toEqual(["@jo"]);
    expect(faces("Book venue")).toEqual(["whost_jo"]);
    reread.answer(
      json({ tasks: [row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_jo"] })] }),
    );
  });

  it("puts back what a re-read found when a later pick fails", async () => {
    // Someone else put Sam on while the first pick was being refused. The
    // re-read after the second refusal is held, so only the put-back shows.
    let reads = 0;
    const later = held();
    const { listbox, writes } = await popoverWithHeldWrites({
      tasks: (init) => {
        reads += 1;
        return reads === 1
          ? json({ tasks: [row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] })] })
          : later.route(init);
      },
    });

    fireEvent.click(option(listbox, "@jo"));
    writes.answer(0, json({ error: "Internal error" }, 500));
    await waitFor(() => expect(faces("Book venue")).toEqual(["whost_sam"]));

    fireEvent.click(option(listbox, "@jo"));
    writes.answer(1, json({ error: "Internal error" }, 500));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
    expect(faces("Book venue")).toEqual(["whost_sam"]);
    expect(ticked(listbox)).toEqual(["Sam Lee"]);
    expect(reads).toBe(2);
    later.answer(
      json({ tasks: [row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] })] }),
    );
  });

  it("keeps a pick still out on screen when the tasks are read again", async () => {
    const { listbox, writes } = await popoverWithHeldWrites({
      tasks: () => json({ tasks: [row({ id: "a", title: "Book venue" })] }),
    });

    fireEvent.click(option(listbox, "@jo"));
    fireEvent.click(option(listbox, "Sam Lee"));
    // Sam is refused, and the re-read lands while Jo's write is still out.
    writes.answer(1, json({ error: "Internal error" }, 500));
    await waitFor(() => expect(calls("/tasks")).toHaveLength(1));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(ticked(listbox)).toEqual(["@jo"]);
    expect(faces("Book venue")).toEqual(["whost_jo"]);
    writes.answer(0, stored(["whost_jo"]));
    await waitFor(() => expect(listbox).not.toHaveAttribute("aria-busy"));
    expect(faces("Book venue")).toEqual(["whost_jo"]);
  });
});

describe("a signed-out organiser", () => {
  it("is sent to sign in when the seats read answers 401", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", title: "Book venue", assigneeHostIds: ["whost_sam"] }),
    ]);
    api({ hosts: () => new Response(null, { status: 401 }) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={false} />);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });

  it("is sent to sign in when a write answers 401", async () => {
    setCachedTasks("wed_1", [row({ id: "a", title: "Book venue" })]);
    api({ hosts: hostsAnswer([SAM, JO]), holder: () => new Response(null, { status: 401 }) });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const { listbox } = await openPopover("Book venue");

    fireEvent.click(option(listbox, "@jo"));
    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
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
    fireEvent.click(assignButton("Book venue"));
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
});
