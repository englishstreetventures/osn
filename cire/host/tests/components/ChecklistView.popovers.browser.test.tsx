import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A checklist row's two popovers as they open and close, in Chromium: the
 * time on the day and the people on the task.
 *
 * Opening one, by mouse or from the keyboard, focuses its panel and nothing
 * in it: no field and no list wears the focus ring, and nobody in the people
 * list is highlighted or named as active, until the pointer or a key moves
 * there. Only a real engine says what matches `:focus-visible` — Chromium
 * draws the ring on a field Kobalte focuses after a mouse click, which a
 * DOM-only tier cannot see.
 *
 * The panel grows and shrinks on transitions, so a close caught mid-growth
 * shrinks from where it is, and a reopening caught mid-close grows from
 * there; keyframes would jump to their own first frame. Measured at a
 * twentieth of the speed (`--motion-scale`), frame by frame. At full speed it
 * grows without a jump or a wobble: every frame larger than the last, never
 * past full size, at most 45px a frame, its corners squaring as it grows. A
 * popover opened from the keyboard is whole on its first frame. A task the
 * organiser adds fades in where it lands; one read from the server does not.
 *
 * Leaves `open-*` screenshots of both popovers at 390 and 1280px in both ramps
 * in the gitignored `__screenshots__/` beside this file.
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
import { __resetEventsCache, type EventRow } from "../../src/lib/events-store";
import { __resetHostsCache, type HostSeat } from "../../src/lib/hosts-store";
import {
  __resetTasksCache,
  readTaskList,
  setCachedTasks,
  type TaskRow,
} from "../../src/lib/tasks-store";

const SYDNEY = "Australia/Sydney";

const row = (over: Partial<TaskRow> & { id: string; title: string }): TaskRow => ({
  weddingId: "wed_1",
  notes: null,
  timeframeBucket: "12m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  assigneeHostIds: [],
  runAt: null,
  runTimezone: null,
  eventId: null,
  runOffsetMinutes: null,
  anchored: false,
  eventRemoved: false,
  ...over,
});

const TASKS = [
  row({ id: "date", title: "Set the date and the guest-count ceiling", sortOrder: 0 }),
  row({ id: "venue", title: "Book the venue", status: "done", completedAt: 2, sortOrder: 1 }),
];

const EVENTS = [
  {
    id: "evt_ceremony",
    name: "Ceremony",
    sortOrder: 0,
    startAt: "2099-06-20T14:00:00+10:00",
    endAt: "",
    timezone: SYDNEY,
  },
] as EventRow[];

const seat = (key: string, role: HostSeat["role"]): HostSeat => ({
  hostId: `whost_${key}`,
  osnProfileId: `usr_${key}`,
  handle: key,
  role,
});
/** The reader first: the owner opening the popover. */
const FOUR = [
  seat("ana", "owner"),
  seat("ben", "editor"),
  seat("cat", "editor"),
  seat("dev", "viewer"),
];
const EIGHT = [...FOUR, ...["eli", "fay", "gus", "hal"].map((key) => seat(key, "viewer"))];

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
] as const;
const THEMES = ["light", "dark"] as const;

/** Beside this file, in the gitignored `__screenshots__/`. */
const shot = (name: string) =>
  `__screenshots__/ChecklistView.popovers.browser.test.tsx/${name}.png`;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** The events, the seats, and a holder write answered as the API stores it. */
function answering(seats: HostSeat[]) {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/events")) return json(EVENTS);
    if (url.endsWith("/hosts"))
      return json({ hosts: seats, total: seats.length, peopleLimit: null });
    if (url.endsWith("/tasks") && init?.method === "POST") {
      const { title } = JSON.parse(String(init.body)) as { title: string };
      return json({ task: row({ id: "added", title, sortOrder: 9 }) });
    }
    const holder = /\/tasks\/([^/]+)\/assignees\/([^/]+)$/.exec(url);
    if (holder) {
      const task = TASKS.find((t) => t.id === holder[1])!;
      return json({
        task: { ...task, assigneeHostIds: init?.method === "PUT" ? [holder[2]] : [] },
      });
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
}

/** The holder writes sent so far, as "PUT whost_ben". */
const writes = () =>
  authFetch.mock.calls
    .filter(([url]) => String(url).includes("/assignees/"))
    .map(([url, init]) => `${(init as RequestInit).method} ${String(url).split("/").pop()}`);

function checklist() {
  setCachedTasks("wed_1", readTaskList("wed_1", { tasks: TASKS, viewerHostId: "whost_ana" }));
  render(() => (
    <div style={{ padding: "16px" }}>
      <ChecklistView weddingId="wed_1" canEdit={true} />
    </div>
  ));
}

const TITLE = "Set the date and the guest-count ceiling";
const assignTrigger = () => screen.getByRole("button", { name: `Assign people to ${TITLE}` });

/** Open a popover with the mouse, or from the keyboard on its trigger. */
async function open(trigger: HTMLElement, how: "mouse" | "keyboard") {
  if (how === "mouse") {
    await userEvent.click(trigger);
  } else {
    trigger.focus();
    await userEvent.keyboard("{Enter}");
  }
}

/** Let the panel come to rest, and Kobalte's focus scope have its turn. */
async function settled(dialog: HTMLElement) {
  await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
  await new Promise((done) => setTimeout(done, 50));
}

/** Nothing in the panel holds the focus or shows the ring: the panel does. */
function expectPanelFocused(dialog: HTMLElement) {
  expect(document.activeElement).toBe(dialog);
  expect(dialog.querySelector(":focus-visible")).toBeNull();
  expect(getComputedStyle(dialog).outlineStyle).toBe("none");
}

/** Nobody in the people list highlighted or named as active. */
function expectNobodyLit(dialog: HTMLElement) {
  const listbox = within(dialog).getByRole("listbox", { name: "People" });
  expect(listbox.hasAttribute("aria-activedescendant")).toBe(false);
  const search = within(dialog).queryByRole("combobox");
  expect(search?.hasAttribute("aria-activedescendant") ?? false).toBe(false);
  for (const option of within(listbox).getAllByRole("option")) {
    expect(getComputedStyle(option).backgroundColor, `${option.textContent} unlit`).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(option, "::before").backgroundColor).toBe("rgba(0, 0, 0, 0)");
  }
}

beforeEach(() => {
  __resetTasksCache();
  __resetHostsCache();
  __resetEventsCache();
  authFetch.mockReset();
  answering(FOUR);
});

afterEach(async () => {
  cleanup();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("--motion-scale");
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("a row's popover opens with nothing focused or highlighted", () => {
  for (const how of ["mouse", "keyboard"] as const) {
    it(`the time popover, opened by ${how}: the panel holds the focus, headed "Set task time" with no sentence under it`, async () => {
      await page.viewport(1280, 800);
      checklist();
      await open(await screen.findByRole("button", { name: new RegExp(`time for ${TITLE}`) }), how);
      const dialog = await screen.findByRole("dialog", { name: "Set task time" });
      await waitFor(() =>
        expect((within(dialog).getByLabelText("Date") as HTMLInputElement).value).toBe(
          "2099-06-20",
        ),
      );
      await settled(dialog);
      expectPanelFocused(dialog);

      // The heading, then the first field: the task's title is said to a
      // screen reader and painted nowhere in the panel.
      const heading = within(dialog).getByText("Set task time");
      const description = document.getElementById(dialog.getAttribute("aria-describedby")!)!;
      expect(description.textContent).toBe(TITLE);
      expect(description.getBoundingClientRect().width).toBeLessThanOrEqual(1);
      const event = within(dialog).getByText("Event");
      const between = [...dialog.querySelectorAll<HTMLElement>("*")].filter((el) => {
        const box = el.getBoundingClientRect();
        return (
          box.width > 1 &&
          box.top >= heading.getBoundingClientRect().bottom &&
          box.bottom <= event.getBoundingClientRect().top &&
          (el.textContent ?? "").trim() !== ""
        );
      });
      expect(between).toEqual([]);

      // Tab moves into the form, onto its first field.
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(within(dialog).getByLabelText("Event"));
    });

    it(`the people popover, opened by ${how}: the panel holds the focus and nobody is highlighted`, async () => {
      await page.viewport(1280, 800);
      checklist();
      await open(await screen.findByRole("button", { name: `Assign people to ${TITLE}` }), how);
      const dialog = await screen.findByRole("dialog", { name: "Assign people" });
      await waitFor(() => expect(within(dialog).queryAllByRole("option")).toHaveLength(4));
      await settled(dialog);
      expectPanelFocused(dialog);
      expectNobodyLit(dialog);

      // Enter here toggles nobody: the reader, listed first, stays off.
      await userEvent.keyboard("{Enter}");
      expect(authFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method)).toBe(false);

      // That Enter moved into the list, on nobody still. From nobody ArrowUp
      // lands on the last person, and ArrowDown goes round to the first.
      const listbox = within(dialog).getByRole("listbox", { name: "People" });
      const options = within(listbox).getAllByRole("option");
      expect(document.activeElement).toBe(listbox);
      expect(listbox.hasAttribute("aria-activedescendant")).toBe(false);
      await userEvent.keyboard("{ArrowUp}");
      expect(listbox.getAttribute("aria-activedescendant")).toBe(options.at(-1)!.id);
      await userEvent.keyboard("{ArrowDown}");
      expect(listbox.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    });
  }

  it("the people popover over a search: the panel holds the focus, and a key typed there goes into the search", async () => {
    await page.viewport(1280, 800);
    answering(EIGHT);
    checklist();
    await userEvent.click(await screen.findByRole("button", { name: `Assign people to ${TITLE}` }));
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    const search = await within(dialog).findByRole("combobox", { name: "Search people" });
    await settled(dialog);
    expectPanelFocused(dialog);
    expectNobodyLit(dialog);

    await userEvent.keyboard("g");
    expect(document.activeElement).toBe(search);
    await waitFor(() => expect((search as HTMLInputElement).value).toBe("g"));
    // Typing aims at the first match.
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.querySelector("[data-name]")?.textContent)).toEqual(["@gus"]);
    expect(search.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
  });

  it("keys on the panel: a modifier or a letter with no search stays put, End goes to the last person, Space toggles the one the pointer lit", async () => {
    await page.viewport(1280, 800);
    checklist();
    const trigger = await screen.findByRole("button", { name: `Assign people to ${TITLE}` });
    await userEvent.click(trigger);
    let dialog = await screen.findByRole("dialog", { name: "Assign people" });
    await waitFor(() => expect(within(dialog).queryAllByRole("option")).toHaveLength(4));
    await settled(dialog);

    // None of these is aimed at the list: the panel keeps the focus.
    await userEvent.keyboard("{Shift}");
    await userEvent.keyboard("{Control>}a{/Control}");
    await userEvent.keyboard("g");
    expectPanelFocused(dialog);
    expectNobodyLit(dialog);

    // End moves in and onto the last person.
    await userEvent.keyboard("{End}");
    const listbox = within(dialog).getByRole("listbox", { name: "People" });
    expect(document.activeElement).toBe(listbox);
    expect(listbox.getAttribute("aria-activedescendant")).toBe(
      within(listbox).getAllByRole("option").at(-1)!.id,
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog.isConnected).toBe(false));

    // Opened again, the pointer lights Ben, and Space on the panel puts him on.
    await userEvent.click(trigger);
    dialog = await screen.findByRole("dialog", { name: "Assign people" });
    await waitFor(() => expect(within(dialog).queryAllByRole("option")).toHaveLength(4));
    await settled(dialog);
    expectPanelFocused(dialog);
    await userEvent.hover(within(dialog).getAllByRole("option")[1]!);
    await userEvent.keyboard(" ");
    await waitFor(() => expect(writes()).toEqual(["PUT whost_ben"]));
  });

  it("over a search, a capital letter typed on the panel goes into the search as typed", async () => {
    await page.viewport(1280, 800);
    answering(EIGHT);
    checklist();
    await userEvent.click(await screen.findByRole("button", { name: `Assign people to ${TITLE}` }));
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    const search = await within(dialog).findByRole("combobox", { name: "Search people" });
    await settled(dialog);
    await userEvent.keyboard("{Shift}");
    expectPanelFocused(dialog);
    await userEvent.keyboard("{Shift>}G{/Shift}");
    expect(document.activeElement).toBe(search);
    await waitFor(() => expect((search as HTMLInputElement).value).toBe("G"));
  });

  it("a hover lights the person under the pointer, and only then", async () => {
    await page.viewport(1280, 800);
    checklist();
    await userEvent.click(await screen.findByRole("button", { name: `Assign people to ${TITLE}` }));
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    await waitFor(() => expect(within(dialog).queryAllByRole("option")).toHaveLength(4));
    await settled(dialog);
    expectNobodyLit(dialog);
    const ben = within(dialog).getAllByRole("option")[1]!;
    await userEvent.hover(ben);
    await waitFor(() => expect(getComputedStyle(ben).backgroundColor).not.toBe("rgba(0, 0, 0, 0)"));
    expect(document.activeElement).toBe(dialog);
  });

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`both popovers, painted as they open — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        checklist();
        await userEvent.click(
          await screen.findByRole("button", { name: new RegExp(`time for ${TITLE}`) }),
        );
        let dialog = await screen.findByRole("dialog", { name: "Set task time" });
        await waitFor(() =>
          expect((within(dialog).getByLabelText("Date") as HTMLInputElement).value).not.toBe(""),
        );
        await settled(dialog);
        expectPanelFocused(dialog);
        // Every field keeps to the form's padding: a long zone or event name
        // does not push its select past the others' edge.
        const form = dialog.querySelector("form")!;
        const edge =
          form.getBoundingClientRect().right -
          Number.parseFloat(getComputedStyle(form).paddingRight);
        for (const field of form.querySelectorAll("select, input:not([type=radio])")) {
          expect(
            field.getBoundingClientRect().right,
            `${field.outerHTML.slice(0, 60)} inside the padding`,
          ).toBeLessThanOrEqual(edge + 0.5);
        }
        await page.screenshot({ path: shot(`open-time-${viewport.name}-${theme}`) });
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(dialog.isConnected).toBe(false));

        await userEvent.click(assignTrigger());
        dialog = await screen.findByRole("dialog", { name: "Assign people" });
        await waitFor(() => expect(within(dialog).queryAllByRole("option")).toHaveLength(4));
        await settled(dialog);
        expectPanelFocused(dialog);
        expectNobodyLit(dialog);
        await page.screenshot({ path: shot(`open-assign-${viewport.name}-${theme}`) });
      });
    }
  }
});

describe("the droplet, caught mid-flight", () => {
  /** The panel's scale and opacity as painted now. */
  const painted = (dialog: HTMLElement) => {
    const style = getComputedStyle(dialog);
    const matrix = style.transform === "none" ? 1 : new DOMMatrixReadOnly(style.transform).a;
    return { scale: matrix, opacity: Number(style.opacity) };
  };
  const frame = () => new Promise<number>((done) => requestAnimationFrame(done));
  /** A corner's radius as painted, in px, from `10px`, `50%` or a
   *  `calc(a% ± bpx)` mid-transition: a percentage is of the width. */
  const radiusPx = (el: HTMLElement) =>
    getComputedStyle(el)
      .borderTopLeftRadius.replace(/^calc\((.*)\)$/, "$1")
      .replace(/ - /g, " + -")
      .split(" + ")
      .reduce((sum, term) => {
        const n = Number.parseFloat(term);
        return sum + (term.trim().endsWith("%") ? (n / 100) * el.offsetWidth : n);
      }, 0);
  /** Every frame's scale for `ms` of page time. */
  async function scales(dialog: HTMLElement, ms: number) {
    const seen: number[] = [];
    const end = performance.now() + ms;
    while (performance.now() < end && dialog.isConnected) {
      await frame();
      if (dialog.isConnected) seen.push(painted(dialog).scale);
    }
    return seen;
  }

  it("shrinks from the size it reached when closed while growing, and grows from there when opened again while closing", async () => {
    await page.viewport(1280, 800);
    // A twentieth of the speed: 4s to grow and 1.8s to shrink at a desk.
    document.documentElement.style.setProperty("--motion-scale", "20");
    checklist();
    await userEvent.click(await screen.findByRole("button", { name: `Assign people to ${TITLE}` }));
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });

    // Caught partway through its growth: past the 60% it shrinks to, short
    // of full size.
    await waitFor(() => expect(painted(dialog).scale).toBeGreaterThan(0.65), { interval: 16 });
    const caught = painted(dialog).scale;
    expect(caught).toBeLessThan(0.97);
    // Still rounder than the panel's 10px: the drop's corners are settling.
    expect(radiusPx(dialog)).toBeGreaterThan(10.5);
    await userEvent.keyboard("{Escape}");
    await frame();
    const radii = [radiusPx(dialog)];
    const closing = await scales(dialog, 300);
    expect(closing.length).toBeGreaterThan(3);
    // Never back up to full size: it goes on from where it was.
    expect(Math.max(...closing)).toBeLessThanOrEqual(caught + 0.05);
    expect(closing.at(-1)!).toBeLessThan(closing[0]!);
    expect(dialog.isConnected).toBe(true);

    // Its corners went on from where they were, rather than jumping to 10px.
    expect(radii.at(0)!).toBeGreaterThan(10.5);

    // Opened again before it has gone: it grows from where it is, not from a
    // drop at the trigger.
    const before = painted(dialog).scale;
    await userEvent.click(assignTrigger());
    const reopening = await scales(dialog, 300);
    expect(dialog.getAttribute("data-expanded")).toBe("");
    expect(Math.min(...reopening)).toBeGreaterThanOrEqual(before - 0.05);
    expect(reopening.at(-1)!).toBeGreaterThan(before);
  });

  it("grows at full speed with no jump and no wobble, its corners squaring as it grows", async () => {
    await page.viewport(1280, 800);
    checklist();
    const trigger = await screen.findByRole("button", { name: `Assign people to ${TITLE}` });
    trigger.click();
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    const frames: { scale: number; radius: number }[] = [];
    while (frames.length < 40) {
      await frame();
      frames.push({ scale: painted(dialog).scale, radius: radiusPx(dialog) });
      if (frames.length > 3 && frames.at(-1)!.scale === 1 && frames.at(-2)!.scale === 1) break;
    }
    const growth = frames.map((f, i) => (i === 0 ? 0 : f.scale - frames[i - 1]!.scale));
    // Larger every frame until full size, and never past it.
    expect(growth.every((g) => g >= -0.0005)).toBe(true);
    expect(Math.max(...frames.map((f) => f.scale))).toBeLessThanOrEqual(1);
    // At most 45px of the panel's width a frame: no frame where it leaps.
    expect(Math.max(...growth) * dialog.offsetWidth).toBeLessThanOrEqual(45);
    // The corners square while it grows, not after it: from round (half the
    // width) to 10px, as far along on every frame as the growth from 60%.
    const round = 0.5 * dialog.offsetWidth;
    for (const f of frames) {
      const squared = (round - f.radius) / (round - 10);
      const grown = (f.scale - 0.6) / 0.4;
      expect(Math.abs(squared - grown), `at ${f.scale}: corners ${f.radius}px`).toBeLessThan(0.1);
    }
  });

  it("is whole on its first frame when the keyboard opened it, and grows again for a click", async () => {
    await page.viewport(1280, 800);
    checklist();
    (await screen.findByRole("button", { name: `Assign people to ${TITLE}` })).focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    expect(dialog.hasAttribute("data-instant")).toBe(true);
    expect(painted(dialog)).toEqual({ scale: 1, opacity: 1 });
    expect(radiusPx(dialog)).toBe(10);
    const body = dialog.querySelector(".droplet-popover-body")!;
    expect(getComputedStyle(body).animationName).toBe("none");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog.isConnected).toBe(false));

    await userEvent.click(screen.getByRole("button", { name: `Assign people to ${TITLE}` }));
    const again = await screen.findByRole("dialog", { name: "Assign people" });
    expect(again.hasAttribute("data-instant")).toBe(false);
    expect(painted(again).scale).toBeLessThan(1);
  });

  it("simply appears and goes for a reader who asked for no motion", async () => {
    await page.viewport(1280, 800);
    await commands.emulateMedia({ reducedMotion: "reduce" });
    checklist();
    await userEvent.click(await screen.findByRole("button", { name: `Assign people to ${TITLE}` }));
    const dialog = await screen.findByRole("dialog", { name: "Assign people" });
    expect(painted(dialog)).toEqual({ scale: 1, opacity: 1 });
    // No grow, fade or rounding runs. (The reduced-motion clamp gives every
    // element a 0.01ms transition of whatever changes, the panel included.)
    const moving = dialog
      .getAnimations()
      .filter((a) => a instanceof CSSTransition)
      .map((a) => (a as CSSTransition).transitionProperty);
    expect(moving.filter((p) => ["transform", "opacity", "border-radius"].includes(p))).toEqual([]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });
});

describe("a task the organiser adds", () => {
  it("fades in where it lands, opacity alone, while the rows read before it arrive at once", async () => {
    await page.viewport(1280, 800);
    checklist();
    await screen.findByTestId("tasks-12m");
    for (const li of screen.getByTestId("tasks-12m").querySelectorAll("li")) {
      expect(getComputedStyle(li).animationName).toBe("none");
    }
    await userEvent.fill(screen.getByLabelText("Task"), "Book the photographer");
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    const added = (await screen.findByRole("checkbox", { name: "Book the photographer" })).closest(
      "li",
    )!;
    expect(getComputedStyle(added).animationName).toBe("row-return");
    expect(Number(getComputedStyle(added).opacity)).toBeLessThan(1);
    expect(getComputedStyle(added).transform).toBe("none");
    await Promise.all(added.getAnimations().map((a) => a.finished));
    await waitFor(() => expect(getComputedStyle(added).animationName).toBe("none"));
    expect(Number(getComputedStyle(added).opacity)).toBe(1);
  });
});
