import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Who holds a checklist task, painted: the avatar stack on each row and the
 * popover that assigns people. Only a real engine can say the stack still fits
 * a row as narrow as a 22rem bucket beside a long title, that the popover stays
 * inside a phone's width, that five people show whole and eight scroll under a
 * search, and that the popover grows from its trigger.
 *
 * Every layout case leaves a screenshot under `__screenshots__/` beside this
 * file (gitignored), at 390 and 1280px in both ramps, so a reviewer can look at
 * what was measured. Photos come from `https://photos.example`, which the
 * `servePhotos` command answers with pictures made in the runner.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import ChecklistView from "../../src/components/ChecklistView";
import { __resetHostsCache, ensureHostsLoaded, type HostSeat } from "../../src/lib/hosts-store";
import {
  __resetTasksCache,
  readTaskList,
  setCachedTasks,
  type TaskRow,
} from "../../src/lib/tasks-store";

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "tsk_1",
  weddingId: "wed_1",
  title: "Book venue",
  notes: null,
  timeframeBucket: "day_of",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  assigneeHostIds: [],
  ...over,
});

const photo = (name: string) => `https://photos.example/${name}.png`;
const seat = (key: string, role: HostSeat["role"], more: Partial<HostSeat> = {}): HostSeat => ({
  hostId: `whost_${key}`,
  osnProfileId: `usr_${key}`,
  handle: key,
  role,
  ...more,
});

/** The reader: an owner, with a photo. */
const ME = seat("ana", "owner", { displayName: "Ana Okafor", avatarUrl: photo("ana") });
const SEATS: HostSeat[] = [
  ME,
  seat("ben", "owner", { displayName: "Ben Okafor", avatarUrl: photo("ben") }),
  seat("maximiliana", "helper", { displayName: "Maximiliana Featherstonehaugh-Okonkwo" }),
  seat("jo", "editor"),
  seat("priya", "viewer", { displayName: "Priya Raman", avatarUrl: photo("priya") }),
  seat("tom", "helper", { displayName: "Tom Ellis" }),
  seat("lea", "viewer", { displayName: "Léa Martin", avatarUrl: photo("lea") }),
  seat("sam", "editor", { displayName: "Sam Lee" }),
];
const FOUR = SEATS.slice(0, 4);
const id = (key: string) => `whost_${key}`;

const TASKS = [
  row({ id: "a", title: "Confirm the string quartet's arrival time", sortOrder: 0 }),
  row({
    id: "b",
    title: "Collect the corsages and buttonholes from the florist on the high street",
    assigneeHostIds: [id("ben")],
    dueAt: "2027-06-05",
    sortOrder: 1,
  }),
  row({
    id: "c",
    title: "Hand the rings to the best man",
    assigneeHostIds: [id("jo"), id("ana")],
    sortOrder: 2,
  }),
  row({
    id: "d",
    title: "Set up the welcome table",
    assigneeHostIds: [id("priya"), id("maximiliana"), id("ana"), id("tom"), id("lea")],
    sortOrder: 3,
  }),
  row({ id: "e", title: "Pack the emergency kit", status: "done", completedAt: 2, sortOrder: 4 }),
  row({
    id: "f",
    title: "Print the order of service",
    status: "done",
    completedAt: 2,
    assigneeHostIds: [id("sam")],
    sortOrder: 5,
  }),
];

// A phone's width, and tall enough to hold the whole checklist: a screenshot of
// a scrolled page comes out with a blank band above it. Opening the popover on
// a scrolled phone-sized page is measured on its own, below.
const VIEWPORTS = [
  { name: "390", width: 390, height: 1280 },
  { name: "1280", width: 1280, height: 800 },
] as const;
const THEMES = ["light", "dark"] as const;

/** Beside this file, in the gitignored `__screenshots__/`. */
const shot = (name: string) => `__screenshots__/ChecklistView.assign.browser.test.tsx/${name}.png`;

const contains = (outer: DOMRect, inner: DOMRect) =>
  inner.left >= outer.left - 0.5 &&
  inner.right <= outer.right + 0.5 &&
  inner.top >= outer.top - 0.5 &&
  inner.bottom <= outer.bottom + 0.5;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const hostsAnswer = (hosts: HostSeat[]) => json({ hosts, total: hosts.length, peopleLimit: null });

/** The seats, and a holder write that answers with the task as stored. */
function answering(seats: HostSeat[]) {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/hosts")) return hostsAnswer(seats);
    const holder = /\/tasks\/([^/]+)\/assignees\/([^/]+)$/.exec(url);
    if (holder) {
      const task = TASKS.find((t) => t.id === holder[1])!;
      const others = task.assigneeHostIds.filter((h) => h !== holder[2]);
      return json({
        task: {
          ...task,
          assigneeHostIds: init?.method === "PUT" ? [...others, holder[2]] : others,
        },
      });
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
}

/** Seed the checklist as `GET /tasks` would, the reader's seat included. */
const seedTasks = (tasks: TaskRow[]) =>
  setCachedTasks("wed_1", readTaskList("wed_1", { tasks, viewerHostId: ME.hostId }));

const rowOf = (title: string) => screen.getByRole("checkbox", { name: title }).closest("li")!;

/** Every photo on the page has loaded or failed, so a screenshot shows the end state. */
async function photosSettled() {
  await Promise.all(
    [...document.querySelectorAll("img")].map((img) =>
      img.complete
        ? undefined
        : new Promise((done) => {
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          }),
    ),
  );
  await waitFor(() =>
    expect([...document.querySelectorAll("img")].every((img) => img.complete)).toBe(true),
  );
}

/** Open a task's popover and let it come to rest. */
async function openPopover(title: string) {
  fireEvent.click(screen.getByRole("button", { name: `Assign people to ${title}` }));
  const dialog = await screen.findByRole("dialog", { name: "Assign people" });
  const listbox = within(dialog).getByRole("listbox", { name: "People" });
  await waitFor(() => expect(within(listbox).queryAllByRole("option").length).toBeGreaterThan(0));
  await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
  await photosSettled();
  return { dialog, listbox };
}

const optionNamed = (listbox: HTMLElement, name: string) =>
  within(listbox)
    .getAllByRole("option")
    .find((o) => o.querySelector("[data-name]")?.textContent === name)!;

beforeEach(async () => {
  __resetTasksCache();
  __resetHostsCache();
  authFetch.mockReset();
  answering(SEATS);
  await commands.servePhotos();
});

afterEach(async () => {
  cleanup();
  delete document.documentElement.dataset.theme;
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("the holders on each row, painted", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const role of ["editor", "viewer"] as const) {
        it(`keeps every row's stack inside it — ${viewport.name}px, ${theme}, as ${role === "editor" ? "an editor" : "a viewer"}`, async () => {
          await page.viewport(viewport.width, viewport.height);
          document.documentElement.dataset.theme = theme;
          seedTasks(TASKS);
          render(() => (
            <div style={{ padding: "16px" }}>
              <ChecklistView weddingId="wed_1" canEdit={role === "editor"} />
            </div>
          ));
          const list = await screen.findByTestId("tasks-day_of");
          await waitFor(() =>
            expect(
              within(rowOf("Set up the welcome table")).getByText(/^Held by /),
            ).toHaveTextContent(
              "Held by Ana Okafor, Priya Raman, Maximiliana Featherstonehaugh-Okonkwo, Tom Ellis and Léa Martin",
            ),
          );
          await photosSettled();

          for (const li of list.querySelectorAll("li")) {
            const box = li.getBoundingClientRect();
            for (const part of li.querySelectorAll(
              "button, input, [data-holder], [data-more], [role=img]",
            )) {
              expect(
                contains(box, part.getBoundingClientRect()),
                `${part.getAttribute("aria-label") ?? part.getAttribute("data-holder") ?? part.textContent} inside its row`,
              ).toBe(true);
            }
          }
          // Three faces and the rest counted, the reader first.
          const welcome = rowOf("Set up the welcome table");
          expect(
            [...welcome.querySelectorAll("[data-holder]")].map((f) =>
              f.getAttribute("data-holder"),
            ),
          ).toEqual([id("ana"), id("priya"), id("maximiliana")]);
          expect(welcome.querySelector("[data-more]")?.textContent).toBe("+2");
          // The faces overlap: each starts before the one before it ends.
          const faces = [...welcome.querySelectorAll("[data-holder]")].map((f) =>
            f.getBoundingClientRect(),
          );
          expect(faces[1]!.left).toBeLessThan(faces[0]!.right);
          // An editor's + is the stack's top layer, over the count's edge; a
          // viewer has none, and sees the empty circle on the open task nobody
          // holds — and nothing on a done one.
          const plus = welcome.querySelector("[data-assign-plus]")?.getBoundingClientRect();
          const more = welcome.querySelector("[data-more]")!.getBoundingClientRect();
          const plusAt =
            plus === undefined
              ? "none"
              : plus.left < more.right && plus.left > more.left
                ? "over the count"
                : "elsewhere";
          expect(plusAt).toBe(role === "editor" ? "over the count" : "none");
          expect(within(list).queryAllByRole("button", { name: /^Assign people/ })).toHaveLength(
            role === "editor" ? TASKS.length : 0,
          );
          expect(
            within(rowOf("Confirm the string quartet's arrival time")).queryAllByRole("img", {
              name: "Nobody assigned yet",
            }),
          ).toHaveLength(role === "editor" ? 0 : 1);
          expect(within(rowOf("Pack the emergency kit")).queryAllByRole("img")).toHaveLength(0);
          // A face without a photo is the empty avatar, not a broken image.
          expect(
            welcome.querySelector(`[data-holder="${id("maximiliana")}"] [data-blank-avatar]`),
          ).not.toBeNull();
          const photoFace = welcome.querySelector<HTMLImageElement>(
            `[data-holder="${id("ana")}"] img`,
          )!;
          expect(photoFace.naturalWidth).toBeGreaterThan(0);

          await page.screenshot({ path: shot(`rows-${role}-${viewport.name}-${theme}`) });
        });
      }
    }
  }
});

describe("the assign popover, painted", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`shows four people whole, two of them ticked — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        answering(FOUR);
        seedTasks(TASKS);
        render(() => (
          <div style={{ padding: "16px" }}>
            <ChecklistView weddingId="wed_1" canEdit={true} />
          </div>
        ));
        await screen.findByTestId("tasks-day_of");
        const { dialog, listbox } = await openPopover("Hand the rings to the best man");

        expect(within(dialog).queryByRole("combobox")).toBeNull();
        const options = within(listbox).getAllByRole("option");
        expect(options).toHaveLength(4);
        expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual([
          "true",
          "false",
          "false",
          "true",
        ]);
        expect(listbox.scrollHeight).toBeLessThanOrEqual(listbox.clientHeight + 1);
        const panel = dialog.getBoundingClientRect();
        expect(panel.left).toBeGreaterThanOrEqual(0);
        expect(panel.right).toBeLessThanOrEqual(viewport.width);
        expect(panel.bottom).toBeLessThanOrEqual(viewport.height);
        for (const o of options) expect(contains(panel, o.getBoundingClientRect())).toBe(true);
        await page.screenshot({ path: shot(`popover-4-${viewport.name}-${theme}`) });
      });

      it(`opens eight people on a search, about four at a time — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        seedTasks(TASKS);
        render(() => (
          <div style={{ padding: "16px" }}>
            <ChecklistView weddingId="wed_1" canEdit={true} />
          </div>
        ));
        await screen.findByTestId("tasks-day_of");
        const { dialog, listbox } = await openPopover("Set up the welcome table");

        const search = within(dialog).getByRole("combobox", { name: "Search people" });
        expect(document.activeElement).toBe(search);
        const options = within(listbox).getAllByRole("option");
        expect(options).toHaveLength(8);
        expect(options.filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(5);
        const rowHeight = options[0]!.getBoundingClientRect().height;
        const shown = listbox.clientHeight / rowHeight;
        expect(shown).toBeGreaterThan(4);
        expect(shown).toBeLessThan(5);
        expect(listbox.scrollHeight).toBeGreaterThan(listbox.clientHeight);
        const panel = dialog.getBoundingClientRect();
        expect(panel.left).toBeGreaterThanOrEqual(0);
        expect(panel.right).toBeLessThanOrEqual(viewport.width);
        expect(panel.bottom).toBeLessThanOrEqual(viewport.height);
        expect(contains(panel, search.getBoundingClientRect())).toBe(true);
        await page.screenshot({ path: shot(`popover-8-${viewport.name}-${theme}`) });
      });
    }
  }
});

describe("opening the popover on a scrolled phone", () => {
  it.each([
    ["four people", FOUR, "Hand the rings to the best man"],
    ["eight people", SEATS, "Set up the welcome table"],
  ])(
    "leaves the page where it was, and keeps the panel on the screen — %s",
    async (_, seats, title) => {
      await page.viewport(390, 844);
      answering(seats);
      seedTasks(TASKS);
      render(() => (
        <div style={{ padding: "16px" }}>
          <ChecklistView weddingId="wed_1" canEdit={true} />
        </div>
      ));
      await screen.findByTestId("tasks-day_of");
      rowOf(title).scrollIntoView({ block: "center" });
      const scrolled = window.scrollY;
      expect(scrolled).toBeGreaterThan(0);

      const { dialog } = await openPopover(title);
      // The panel is put beside its trigger a frame after it opens; focusing
      // it before then, with a scroll, jumped the page to the top.
      expect(window.scrollY).toBe(scrolled);
      const panel = dialog.getBoundingClientRect();
      expect(panel.left).toBeGreaterThanOrEqual(0);
      expect(panel.right).toBeLessThanOrEqual(390);
      expect(panel.top).toBeGreaterThanOrEqual(0);
      expect(panel.bottom).toBeLessThanOrEqual(844);
    },
  );
});

describe("the search threshold, measured", () => {
  it("shows five people whole with no search, and six under a search that scrolls", async () => {
    await page.viewport(1280, 800);
    answering(SEATS.slice(0, 5));
    seedTasks([row({ id: "a", title: "Book venue" })]);
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    let { dialog, listbox } = await openPopover("Book venue");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(listbox).getAllByRole("option")).toHaveLength(5);
    expect(listbox.scrollHeight).toBeLessThanOrEqual(listbox.clientHeight + 1);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog.isConnected).toBe(false));

    cleanup();
    __resetHostsCache();
    answering(SEATS.slice(0, 6));
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    ({ dialog, listbox } = await openPopover("Book venue"));
    expect(within(dialog).getByRole("combobox", { name: "Search people" })).toBeTruthy();
    expect(within(listbox).getAllByRole("option")).toHaveLength(6);
    expect(listbox.scrollHeight).toBeGreaterThan(listbox.clientHeight);
  });
});

describe("the popover's motion", () => {
  it("grows from the trigger on a spring, and simply appears for a reader who asked for no motion", async () => {
    await page.viewport(1280, 800);
    answering(FOUR);
    seedTasks([row({ id: "a", title: "Book venue" })]);
    render(() => (
      <div style={{ padding: "16px" }}>
        <ChecklistView weddingId="wed_1" canEdit={true} />
      </div>
    ));
    fireEvent.click(screen.getByRole("button", { name: "Assign people to Book venue" }));
    let dialog = await screen.findByRole("dialog", { name: "Assign people" });
    const style = getComputedStyle(dialog);
    expect(style.animationName).toBe("droplet-grow, droplet-round");
    expect(style.animationTimingFunction.startsWith("linear(")).toBe(true);
    await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
    // The drop leaves from the panel's corner at the trigger: its right edge,
    // and its top when it opened below the trigger or its bottom when above.
    const [x, y] = style.transformOrigin.split(" ").map(Number.parseFloat);
    const box = dialog.getBoundingClientRect();
    const trigger = screen
      .getByRole("button", { name: "Assign people to Book venue" })
      .getBoundingClientRect();
    expect(x).toBeCloseTo(box.width, 0);
    expect(Math.abs(box.left + x - trigger.right)).toBeLessThan(1);
    expect(y).toBeCloseTo(box.top >= trigger.bottom ? 0 : box.height, 0);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog.isConnected).toBe(false));

    await commands.emulateMedia({ reducedMotion: "reduce" });
    fireEvent.click(screen.getByRole("button", { name: "Assign people to Book venue" }));
    dialog = await screen.findByRole("dialog", { name: "Assign people" });
    for (const part of [dialog, dialog.querySelector(".assign-popover-body")!]) {
      expect(Number.parseFloat(getComputedStyle(part).animationDuration)).toBeLessThan(0.001);
      expect(
        getComputedStyle(part)
          .animationDelay.split(", ")
          .every((d) => d === "0s"),
      ).toBe(true);
    }
  });
});

describe("the popover from the keyboard, in Chrome", () => {
  it("keeps the focus on the list through writes that are out, and stores every toggle", async () => {
    await page.viewport(1280, 800);
    seedTasks([row({ id: "a", title: "Book venue" })]);
    answering(FOUR);
    const releases: (() => void)[] = [];
    const sent: string[] = [];
    const stored: string[] = [];
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/hosts")) return hostsAnswer(FOUR);
      const hostId = url.split("/").pop()!;
      sent.push(`${init?.method} ${hostId}`);
      // Stored as it arrives; the answer is held until the test lets it go.
      stored.push(hostId);
      const answer = json({
        task: row({ id: "a", title: "Book venue", assigneeHostIds: [...stored] }),
      });
      return new Promise<Response>((resolve) => releases.push(() => resolve(answer)));
    });
    render(() => (
      <div style={{ padding: "16px" }}>
        <ChecklistView weddingId="wed_1" canEdit={true} />
      </div>
    ));
    const { listbox } = await openPopover("Book venue");
    expect(document.activeElement).toBe(listbox);

    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard(" ");
    await waitFor(() => expect(sent).toEqual([`PUT ${id("ben")}`]));
    expect(listbox.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(listbox);
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    // A second person goes at once, without waiting for the first.
    await waitFor(() => expect(sent).toEqual([`PUT ${id("ben")}`, `PUT ${id("maximiliana")}`]));
    expect(document.activeElement).toBe(listbox);

    for (const release of releases) release();
    await waitFor(() => expect(listbox.hasAttribute("aria-busy")).toBe(false));
    expect(document.activeElement).toBe(listbox);
    expect(optionNamed(listbox, "Ben Okafor").getAttribute("aria-selected")).toBe("true");
    expect(
      optionNamed(listbox, "Maximiliana Featherstonehaugh-Okonkwo").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      [...rowOf("Book venue").querySelectorAll("[data-holder]")].map((f) =>
        f.getAttribute("data-holder"),
      ),
    ).toEqual([id("ben"), id("maximiliana")]);
    await page.screenshot({ path: shot("popover-keyboard") });
  });
});

describe("the popover's list, in Chrome", () => {
  it("paints the highlight and the ticks, follows the highlight down, keeps the focus in the search, and hands it back on Tab", async () => {
    await page.viewport(1280, 800);
    seedTasks(TASKS);
    render(() => (
      <div style={{ padding: "16px" }}>
        <ChecklistView weddingId="wed_1" canEdit={true} />
      </div>
    ));
    const trigger = await screen.findByRole("button", {
      name: "Assign people to Set up the welcome table",
    });
    const { dialog, listbox } = await openPopover("Set up the welcome table");
    const search = within(dialog).getByRole("combobox", { name: "Search people" });
    expect(document.activeElement).toBe(search);
    const options = within(listbox).getAllByRole("option");
    const paint = (el: Element) => getComputedStyle(el).backgroundColor;

    // The highlighted row and a ticked circle are painted, not only named:
    // the highlight on the first row alone, a fill in the ticked circle alone,
    // and the empty circle's edge in its own ink.
    const clear = "rgba(0, 0, 0, 0)";
    expect(paint(options[0]!)).not.toBe(clear);
    expect(paint(options[1]!)).toBe(clear);
    const circle = (state: string) =>
      options
        .find((o) => o.getAttribute("aria-selected") === state)!
        .querySelector("[data-toggle]")!;
    expect(paint(circle("true"))).not.toBe(clear);
    expect(paint(circle("false"))).toBe(clear);
    expect(getComputedStyle(circle("false")).borderTopColor).not.toBe(
      getComputedStyle(circle("false")).color,
    );

    await userEvent.keyboard("{End}");
    await waitFor(() => expect(listbox.scrollTop).toBeGreaterThan(0));
    expect(options.at(-1)!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      listbox.getBoundingClientRect().bottom + 1,
    );

    await userEvent.click(optionNamed(listbox, "Ben Okafor"));
    expect(optionNamed(listbox, "Ben Okafor").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(search);

    await userEvent.keyboard("{Tab}");
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("a re-read of the seats while the popover is open, in Chrome", () => {
  it("keeps every tick, the highlighted person and their row", async () => {
    await page.viewport(1280, 800);
    // Read on an earlier visit, so the first opening of this one reads again.
    await ensureHostsLoaded("wed_1", async () => FOUR);
    seedTasks([row({ id: "a", title: "Book venue", assigneeHostIds: [id("jo")] })]);
    let release: () => void = () => {};
    const newcomer = seat("newcomer", "viewer");
    authFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          // New objects, as every read hands back, with one more seat on the end.
          release = () => resolve(hostsAnswer([...structuredClone(FOUR), newcomer]));
        }),
    );
    render(() => (
      <div style={{ padding: "16px" }}>
        <ChecklistView weddingId="wed_1" canEdit={true} />
      </div>
    ));
    const { listbox } = await openPopover("Book venue");
    await userEvent.keyboard("{End}");
    const jo = optionNamed(listbox, "@jo");
    expect(listbox.getAttribute("aria-activedescendant")).toBe(jo.id);
    expect(jo.getAttribute("aria-selected")).toBe("true");

    release();
    await waitFor(() => expect(optionNamed(listbox, "@newcomer")).toBeTruthy());
    expect(optionNamed(listbox, "@jo")).toBe(jo);
    expect(jo.getAttribute("aria-selected")).toBe("true");
    expect(listbox.getAttribute("aria-activedescendant")).toBe(jo.id);
    await page.screenshot({ path: shot("popover-reread") });
  });
});
