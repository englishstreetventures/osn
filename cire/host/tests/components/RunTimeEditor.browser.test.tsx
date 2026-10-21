import { contrastRatio, WCAG_TEXT_MIN, WCAG_UI_MIN } from "@cire/theme";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A task's time on its checklist row, painted: the trigger on the row and the
 * popover it opens. Only a real engine can say the trigger fits a row as
 * narrow as a 22rem bucket beside its title and the holders, that the popover
 * stays inside a phone's width with every field whole, that its words and the
 * slot's dotted edge clear their contrast floors in both ramps, that Tab stays
 * inside the popover while it is open, and that the focus is back on the
 * trigger once a time is saved.
 *
 * Every layout case leaves a screenshot under `__screenshots__/` beside this
 * file (gitignored), at 390 and 1280px in both ramps: the rows, the popover
 * on a linked task and on an untimed one.
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
  timeframeBucket: "day_of",
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

const EVENTS = [
  {
    id: "evt_ceremony",
    name: "Ceremony",
    sortOrder: 0,
    startAt: "2099-06-20T14:00:00+10:00",
    endAt: "2099-06-20T14:45:00+10:00",
    timezone: SYDNEY,
  },
  {
    id: "evt_reception",
    name: "Reception",
    sortOrder: 1,
    startAt: "2099-06-20T17:30:00+10:00",
    endAt: "",
    timezone: SYDNEY,
  },
] as EventRow[];

const SEATS: HostSeat[] = [
  { hostId: "whost_ana", osnProfileId: "usr_ana", displayName: "Ana Okafor", role: "owner" },
  { hostId: "whost_ben", osnProfileId: "usr_ben", displayName: "Ben Okafor", role: "editor" },
];

const TASKS = [
  row({
    id: "rings",
    title: "Bring the rings",
    assigneeHostIds: ["whost_ana"],
    sortOrder: 0,
  }),
  row({
    id: "greet",
    title: "Greet the celebrant and walk them down to the arbour",
    runAt: "2099-06-20T13:30:00+10:00",
    runTimezone: SYDNEY,
    eventId: "evt_ceremony",
    runOffsetMinutes: -30,
    anchored: true,
    assigneeHostIds: ["whost_ben"],
    sortOrder: 1,
  }),
  row({
    id: "cake",
    title: "Set up the cake table",
    runAt: "2099-06-20T15:00:00+10:00",
    runTimezone: SYDNEY,
    eventRemoved: true,
    sortOrder: 2,
  }),
  row({
    id: "flowers",
    title: "Collect the flowers",
    runAt: "2099-06-20T10:00:00+05:30",
    runTimezone: "Asia/Kolkata",
    sortOrder: 3,
  }),
];

const VIEWPORTS = [
  { name: "390", width: 390, height: 1100 },
  { name: "1280", width: 1280, height: 800 },
] as const;
const THEMES = ["light", "dark"] as const;

/** Beside this file, in the gitignored `__screenshots__/`. */
const shot = (name: string) => `__screenshots__/RunTimeEditor.browser.test.tsx/${name}.png`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The events, the seats, and a run-time write answered as the API stores it. */
function answering() {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/events")) return json(EVENTS);
    if (url.endsWith("/hosts"))
      return json({ hosts: SEATS, total: SEATS.length, peopleLimit: null });
    const write = /\/tasks\/([^/]+)$/.exec(url);
    if (write && init?.method === "PATCH") {
      const task = TASKS.find((t) => t.id === write[1])!;
      const { runTime } = JSON.parse(String(init.body)) as {
        runTime: { kind: string; at?: string; timezone?: string } | null;
      };
      const fixed = runTime?.kind === "fixed";
      return json({
        task: {
          ...task,
          runAt: fixed ? `${runTime!.at}:00+10:00` : null,
          runTimezone: fixed ? runTime!.timezone : null,
          eventId: null,
          runOffsetMinutes: null,
          anchored: false,
          eventRemoved: false,
        },
      });
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
}

function checklist(canEdit = true) {
  setCachedTasks("wed_1", readTaskList("wed_1", { tasks: TASKS, viewerHostId: "whost_ana" }));
  render(() => (
    <div style={{ padding: "16px" }}>
      <ChecklistView weddingId="wed_1" canEdit={canEdit} />
    </div>
  ));
}

const rowOf = (title: string) => screen.getByRole("checkbox", { name: title }).closest("li")!;
const triggerFor = (title: string) =>
  screen.getByRole("button", { name: new RegExp(`time for ${title}`) });

const contains = (outer: DOMRect, inner: DOMRect) =>
  inner.left >= outer.left - 0.5 &&
  inner.right <= outer.right + 0.5 &&
  inner.top >= outer.top - 0.5 &&
  inner.bottom <= outer.bottom + 0.5;

/** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

function alphaOf(colour: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
}

/** What `element` sits on, over the page's own ground. */
function backdropOf(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (alphaOf(bg) > 0) layers.push(bg);
  }
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  return composite([ground, ...layers.toReversed()]);
}

/** `colour` over what sits behind `element`, against that. For a control's
 *  own edge, what is behind it is its parent's backdrop. */
function ratioOn(element: Element, colour: string): number {
  const backdrop = backdropOf(element);
  return contrastRatio(composite([backdrop, colour]), backdrop)!;
}

/** Every element in `root` that paints words of its own. */
function wordsIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("*")].filter((el) => {
    const own = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
    );
    const box = el.getBoundingClientRect();
    return own && box.width > 1 && box.height > 1 && el.tagName !== "OPTION";
  });
}

async function openFor(title: string) {
  triggerFor(title).click();
  const dialog = await screen.findByRole("dialog", { name: "Time on the day" });
  await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
  return dialog;
}

/** The popover inside the screen, every field whole inside the panel, and
 *  every word in it readable. */
function expectPanelWhole(dialog: HTMLElement, viewport: { width: number; height: number }) {
  const panel = dialog.getBoundingClientRect();
  expect(panel.left).toBeGreaterThanOrEqual(0);
  expect(panel.right).toBeLessThanOrEqual(viewport.width);
  expect(panel.bottom).toBeLessThanOrEqual(viewport.height);
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  for (const control of dialog.querySelectorAll("input, select, button")) {
    expect(
      contains(panel, control.getBoundingClientRect()),
      `${control.outerHTML.slice(0, 60)} inside the panel`,
    ).toBe(true);
  }
  for (const el of wordsIn(dialog)) {
    const measured = ratioOn(el, getComputedStyle(el).color);
    expect(
      measured,
      `"${el.textContent}" reads at ${measured.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
  }
}

beforeEach(() => {
  __resetTasksCache();
  __resetHostsCache();
  __resetEventsCache();
  authFetch.mockReset();
  answering();
});

afterEach(async () => {
  cleanup();
  delete document.documentElement.dataset.theme;
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("a task's time on its row, painted", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`keeps each row's time inside it, and readable — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        checklist();
        await screen.findByTestId("tasks-day_of");
        await document.fonts.ready;

        // The time on its own clock: Kolkata's 10 am, not Sydney's 2:30 pm,
        // and its zone, which is not the reader's.
        expect(triggerFor("Collect the flowers").textContent).toMatch(/^10:00\samGMT\+5:30,/);
        expect(triggerFor("Greet the celebrant").textContent).toMatch(/^1:30\spm/);
        for (const title of [
          "Bring the rings",
          "Greet the celebrant",
          "Set up the cake table",
          "Collect the flowers",
        ]) {
          const li = rowOf(title === "Greet the celebrant" ? TASKS[1]!.title : title);
          const trigger = triggerFor(title);
          expect(
            contains(li.getBoundingClientRect(), trigger.getBoundingClientRect()),
            `${title}'s time inside its row`,
          ).toBe(true);
        }
        // The empty slot is a 28px circle whose dotted edge clears 3:1.
        const slot = triggerFor("Bring the rings");
        const box = slot.getBoundingClientRect();
        expect([Math.round(box.width), Math.round(box.height)]).toEqual([28, 28]);
        const edge = ratioOn(slot.parentElement!, getComputedStyle(slot).borderTopColor);
        expect(edge, `the slot's edge at ${edge.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG_UI_MIN);
        // A time's words read at 4.5:1, the removed one's warning ink included.
        for (const title of ["Greet the celebrant", "Set up the cake table"]) {
          const words = triggerFor(title).querySelector("span:not(.sr-only)")!;
          const measured = ratioOn(words, getComputedStyle(words).color);
          expect(measured, `${title}'s time at ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            WCAG_TEXT_MIN,
          );
        }
        await page.screenshot({ path: shot(`rows-${viewport.name}-${theme}`) });
      });

      it(`opens a linked time on its event, with no zone to pick — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        checklist();
        await screen.findByTestId("tasks-day_of");
        const dialog = await openFor("Greet the celebrant");
        await waitFor(() =>
          expect((within(dialog).getByLabelText("Event") as HTMLSelectElement).value).toBe(
            "evt_ceremony",
          ),
        );

        expect(
          (
            within(dialog).getByRole("radio", {
              name: "Before or after the start",
            }) as HTMLInputElement
          ).checked,
        ).toBe(true);
        expect((within(dialog).getByLabelText("Minutes") as HTMLInputElement).value).toBe("30");
        expect((within(dialog).getByLabelText("Before or after") as HTMLSelectElement).value).toBe(
          "before",
        );
        expect(within(dialog).queryByLabelText("Time zone")).toBeNull();
        expect(dialog.textContent).toContain("Sat 20 Jun, 1:30 pm, on Ceremony's clock");
        // The row's droplet: the same spring the holders' popover lands with.
        expect(getComputedStyle(dialog).animationName).toBe("droplet-grow, droplet-round");

        expectPanelWhole(dialog, viewport);
        await page.screenshot({ path: shot(`editor-linked-${viewport.name}-${theme}`) });
      });

      it(`opens an untimed task on a fixed time in the wedding's zone — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        checklist();
        await screen.findByTestId("tasks-day_of");
        const dialog = await openFor("Bring the rings");
        // The events land after it opened, and bring the day and the zone.
        await waitFor(() =>
          expect((within(dialog).getByLabelText("Time zone") as HTMLSelectElement).value).toBe(
            SYDNEY,
          ),
        );
        expect((within(dialog).getByLabelText("Date") as HTMLInputElement).value).toBe(
          "2099-06-20",
        );
        expect((within(dialog).getByLabelText("Event") as HTMLSelectElement).value).toBe("");
        expect(within(dialog).queryByRole("button", { name: "Clear time" })).toBeNull();

        expectPanelWhole(dialog, viewport);
        await page.screenshot({ path: shot(`editor-unlinked-${viewport.name}-${theme}`) });
      });
    }
  }
});

describe("the popover, from the keyboard", () => {
  it("keeps Tab inside while open, and Escape hands the focus back", async () => {
    await page.viewport(390, 1100);
    checklist();
    await screen.findByTestId("tasks-day_of");
    triggerFor("Bring the rings").focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Time on the day" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const stops = dialog.querySelectorAll("input, select, button").length;
    for (let i = 0; i < stops + 2; i++) {
      await userEvent.keyboard("{Tab}");
      expect(dialog.contains(document.activeElement), `Tab ${i + 1} stays in the popover`).toBe(
        true,
      );
    }
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Time on the day" })).toBeNull(),
    );
    // Kobalte hands it back as the panel unmounts, a tick after it leaves.
    await waitFor(() => expect(document.activeElement).toBe(triggerFor("Bring the rings")));
  });

  it("saves from the keyboard and leaves the focus on the trigger, now showing the time", async () => {
    await page.viewport(390, 1100);
    checklist();
    await screen.findByTestId("tasks-day_of");
    triggerFor("Bring the rings").focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Time on the day" });
    await waitFor(() =>
      expect((within(dialog).getByLabelText("Date") as HTMLInputElement).value).toBe("2099-06-20"),
    );
    await userEvent.fill(within(dialog).getByLabelText("Time"), "12:00");
    (within(dialog).getByLabelText("Time") as HTMLInputElement).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Time on the day" })).toBeNull(),
    );
    const trigger = triggerFor("Bring the rings");
    expect(trigger.textContent).toMatch(/^12:00\spm/);
    expect(document.activeElement).toBe(trigger);
    const patch = authFetch.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    )!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      runTime: { kind: "fixed", at: "2099-06-20T12:00", timezone: SYDNEY },
    });
  });
});

describe("a viewer's checklist", () => {
  for (const theme of THEMES) {
    it(`shows each time as words, with nothing to press — 390px, ${theme}`, async () => {
      await page.viewport(390, 1100);
      document.documentElement.dataset.theme = theme;
      checklist(false);
      await screen.findByTestId("tasks-day_of");
      expect(screen.queryAllByRole("button", { name: /time for/ })).toHaveLength(0);
      const greet = rowOf(TASKS[1]!.title);
      // The zone shows only when it is not the reader's: this browser's own.
      const away = Intl.DateTimeFormat().resolvedOptions().timeZone !== SYDNEY;
      expect(greet.textContent).toMatch(
        new RegExp(`1:30\\spm${away ? "AEST" : ""}, time for Greet the celebrant`),
      );
      expect(rowOf("Bring the rings").textContent).not.toMatch(/time for/);
      await page.screenshot({ path: shot(`rows-viewer-390-${theme}`) });
    });
  }
});
