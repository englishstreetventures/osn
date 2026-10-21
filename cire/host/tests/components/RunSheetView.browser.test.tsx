import { contrastRatio, WCAG_TEXT_MIN, WCAG_UI_MIN } from "@cire/theme";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The run sheet, painted. Only a real engine can say that every row's marker
 * sits on the day's thread whatever the row holds, that the holders take a
 * third column once the view is wide and drop under the title before that,
 * that nothing runs past a phone's width, and that every word on the sheet —
 * the flags on their washes, a coming-up row's gold, an event's band — reads
 * at 4.5:1 in both ramps.
 *
 * Every case leaves a screenshot under `__screenshots__/` beside this file
 * (gitignored), at 390 and 1280px in both ramps: the whole day as an owner,
 * an `own` helper's day, and the below-Gold message. The clock is pinned to
 * 1:10 pm Sydney on the day, so "Greet the celebrant" at 1:30 pm is coming
 * up. The Ceremony and the Reception carry runs of show, the Reception's with
 * a long item and one after midnight: they sit inside their bands, in the
 * words' column, past the thread. Photos come from `https://photos.example`, answered by `servePhotos`.
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

import RunSheetView from "../../src/components/RunSheetView";
import {
  __resetRunSheetCache,
  type RunSheet,
  type RunSheetEventItem,
  type RunSheetPerson,
  type RunSheetTaskItem,
} from "../../src/lib/run-sheet-store";

const SYDNEY = "Australia/Sydney";
/** 1:10 pm on the day, Sydney: twenty minutes before the celebrant is met. */
const NOW = Date.parse("2099-06-20T13:10:00+10:00");

const task = (
  over: Partial<RunSheetTaskItem> & { id: string; title: string },
): RunSheetTaskItem => ({
  kind: "task",
  notes: null,
  status: "open",
  runAt: null,
  runTimezone: null,
  eventId: null,
  runOffsetMinutes: null,
  anchored: false,
  eventRemoved: false,
  assigneeHostIds: [],
  ...over,
});
const event = (
  over: Partial<RunSheetEventItem> & { id: string; name: string },
): RunSheetEventItem => ({
  kind: "event",
  startAt: "",
  endAt: "",
  timezone: SYDNEY,
  venueName: null,
  address: null,
  runOfShow: [],
  ...over,
});
const photo = (name: string) => `https://photos.example/${name}.png`;
const person = (key: string, more: Partial<RunSheetPerson> = {}): RunSheetPerson => ({
  hostId: `whost_${key}`,
  osnProfileId: `usr_${key}`,
  handle: key,
  ...more,
});
const id = (key: string) => `whost_${key}`;

const PEOPLE = [
  person("ana", { displayName: "Ana Okafor", avatarUrl: photo("ana") }),
  person("ben", { displayName: "Ben Okafor", avatarUrl: photo("ben") }),
  person("priya", { displayName: "Priya Raman", avatarUrl: photo("priya") }),
  person("jo"),
  person("maximiliana", { displayName: "Maximiliana Featherstonehaugh-Okonkwo" }),
  person("tom", { displayName: "Tom Ellis" }),
  person("lea", { displayName: "Léa Martin", avatarUrl: photo("lea") }),
];

const CEREMONY = event({
  id: "evt_ceremony",
  name: "Ceremony",
  startAt: "2099-06-20T14:00:00+10:00",
  endAt: "2099-06-20T14:45:00+10:00",
  venueName: "The Boathouse",
  address: "1 Ocean Street, Palm Beach NSW 2108",
  runOfShow: [
    { time: "14:25", label: "Signing of the register" },
    { time: "14:05", label: "Processional" },
  ],
});
const RECEPTION = event({
  id: "evt_reception",
  name: "Reception",
  startAt: "2099-06-20T17:30:00+10:00",
  endAt: "2099-06-21T00:30:00+10:00",
  venueName: "The Boathouse",
  address: "1 Ocean Street, Palm Beach NSW 2108",
  runOfShow: [
    { time: "17:30", label: "Guests seated" },
    {
      time: "18:15",
      label: "Entrée, then the speeches from both families and a toast to the couple's parents",
    },
    { time: "00:15", label: "Last bus to the city" },
    { time: "22:45", label: "Sparklers send-off" },
  ],
});
const GREET = task({
  id: "greet",
  title: "Greet the celebrant and walk them down to the arbour",
  runAt: "2099-06-20T13:30:00+10:00",
  runTimezone: SYDNEY,
  eventId: CEREMONY.id,
  runOffsetMinutes: -30,
  anchored: true,
  assigneeHostIds: [id("ben"), id("tom")],
});
const DANCE = task({
  id: "dance",
  title: "Cue the first dance",
  notes: "Song: “At Last” — the DJ has it queued.\nDim the lights first.",
  runAt: "2099-06-20T21:00:00+10:00",
  runTimezone: SYDNEY,
  eventId: RECEPTION.id,
  runOffsetMinutes: 210,
  anchored: true,
  assigneeHostIds: [id("ben"), id("priya"), id("ana"), id("tom"), id("lea")],
});

/** The whole day, as an owner reads it: two days, the second in two zones. */
const OWNER: RunSheet = {
  scope: "full",
  viewerHostId: id("ana"),
  items: [
    task({
      id: "hair",
      title: "Hair and makeup for the bridal party",
      status: "done",
      runAt: "2099-06-20T09:00:00+10:00",
      runTimezone: SYDNEY,
      assigneeHostIds: [id("priya"), id("ana")],
    }),
    GREET,
    CEREMONY,
    task({
      id: "rings",
      title: "Hand the rings to the best man",
      runAt: "2099-06-20T14:00:00+10:00",
      runTimezone: SYDNEY,
      eventId: CEREMONY.id,
      runOffsetMinutes: 0,
      anchored: true,
      assigneeHostIds: [id("jo"), id("ana")],
    }),
    task({
      id: "cake",
      title: "Set up the cake table",
      runAt: "2099-06-20T15:00:00+10:00",
      runTimezone: SYDNEY,
      eventRemoved: true,
      assigneeHostIds: [id("maximiliana")],
    }),
    RECEPTION,
    DANCE,
    event({
      id: "evt_brunch",
      name: "Recovery brunch",
      startAt: "2099-06-21T11:00:00+10:00",
      endAt: "2099-06-21T13:00:00+10:00",
      venueName: "Ruby's Café",
    }),
    task({
      id: "nani",
      title: "Video call with Nani",
      runAt: "2099-06-21T10:00:00+05:30",
      runTimezone: "Asia/Kolkata",
      assigneeHostIds: [id("ana")],
    }),
    task({ id: "kit", title: "Bring the emergency kit" }),
    task({
      id: "guestbook",
      title: "Pack the guest book and pens",
      status: "done",
      assigneeHostIds: [id("lea")],
    }),
  ],
  people: PEOPLE,
};

/** Tom's day: a helper who sees only his own tasks, and their events. */
const HELPER: RunSheet = {
  scope: "own",
  viewerHostId: id("tom"),
  items: [
    GREET,
    CEREMONY,
    RECEPTION,
    DANCE,
    task({
      id: "chairs",
      title: "Return the hire chairs",
      status: "done",
      assigneeHostIds: [id("tom")],
    }),
  ],
  people: PEOPLE.filter((p) =>
    [id("ben"), id("tom"), id("ana"), id("priya"), id("lea")].includes(p.hostId),
  ),
};

const VIEWPORTS = [
  { name: "390", width: 390, height: 1600 },
  { name: "1280", width: 1280, height: 1320 },
] as const;
const THEMES = ["light", "dark"] as const;

/** Beside this file, in the gitignored `__screenshots__/`. */
const shot = (name: string) => `__screenshots__/RunSheetView.browser.test.tsx/${name}.png`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const rowOf = (itemId: string) =>
  document.querySelector<HTMLElement>(`[data-run-sheet-item="${itemId}"]`)!;

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

/** How opaque a colour is, 0 to 1, as the engine paints it. */
function alphaOf(colour: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
}

/** What `element` sits on: every ancestor's background, outermost first, its
 *  own last, over the page's own ground. */
function backdropOf(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (alphaOf(bg) > 0) layers.push(bg);
  }
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  return composite([ground, ...layers.toReversed()]);
}

/** `colour` over `element`'s backdrop, against that backdrop. */
function ratioOn(element: Element, colour: string): number {
  const backdrop = backdropOf(element);
  return contrastRatio(composite([backdrop, colour]), backdrop)!;
}

/** Every element in `root` that paints words of its own — not the hidden
 *  text a screen reader alone hears. */
function wordsIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("*")].filter((el) => {
    const own = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
    );
    const box = el.getBoundingClientRect();
    return own && box.width > 1 && box.height > 1;
  });
}

/** Every photo on the page has loaded or failed. */
async function photosSettled() {
  await waitFor(() =>
    expect([...document.querySelectorAll("img")].every((img) => img.complete)).toBe(true),
  );
}

async function show(sheet: RunSheet, props: { canEdit: boolean; helper: boolean }) {
  authFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/run-sheet")) return json(sheet);
    throw new Error(`unexpected ${url}`);
  });
  render(() => (
    <div style={{ padding: "16px" }}>
      <RunSheetView
        weddingId="wed_1"
        tier="gold"
        callerRole={props.helper ? "helper" : "owner"}
        canEdit={props.canEdit}
        onOpenChecklist={props.canEdit ? () => {} : undefined}
      />
    </div>
  ));
  await waitFor(() =>
    expect(document.querySelectorAll("[data-run-sheet-item]").length).toBe(sheet.items.length),
  );
  await photosSettled();
  await document.fonts.ready;
}

/** The layout every run sheet keeps, at any width, in either ramp. */
function expectLaidOut(width: number) {
  // No sideways scroll anywhere on the page.
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const wide = width >= 1000;
  for (const ol of document.querySelectorAll<HTMLElement>("ol.run-sheet-day")) {
    const box = ol.getBoundingClientRect();
    const thread = getComputedStyle(ol, "::before");
    const threadX = box.left + parseFloat(thread.insetInlineStart) + parseFloat(thread.width) / 2;
    for (const li of ol.querySelectorAll<HTMLElement>(":scope > li")) {
      const row = li.getBoundingClientRect();
      const what = li.dataset.runSheetItem;
      expect(contains(box, row), `${what} inside its day`).toBe(true);
      for (const part of li.querySelectorAll(
        "time, p, [data-flag], [data-holder], [data-more], [role=img]",
      )) {
        expect(
          contains(row, part.getBoundingClientRect()),
          `${what}: "${part.textContent}" inside its row`,
        ).toBe(true);
      }
      // The marker sits on the thread, level with the first line of the title.
      const mark = li.querySelector(".run-sheet-mark")!.getBoundingClientRect();
      expect(
        Math.abs(mark.left + mark.width / 2 - threadX),
        `${what}'s marker on the thread`,
      ).toBeLessThan(1);
      const title = li.querySelector("p")!;
      const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
      const firstLine = title.getBoundingClientRect().top + lineHeight / 2;
      expect(
        Math.abs(mark.top + mark.height / 2 - firstLine),
        `${what}'s marker on its first line`,
      ).toBeLessThan(1.5);
      // The time column ends before the thread; the words start after it.
      // An untimed row has no time, and reads as one that ends at the start.
      const timeEnd = li.querySelector("time")?.getBoundingClientRect().right ?? row.left;
      // An event's run of show hangs in its words' column, inside its band.
      for (const item of li.querySelectorAll<HTMLElement>("[data-run-of-show-item]")) {
        const line = item.getBoundingClientRect();
        expect(contains(row, line), `${what}: "${item.textContent}" inside its band`).toBe(true);
        expect(line.left, `${what}: "${item.textContent}" past the thread`).toBeGreaterThan(
          threadX,
        );
      }
      expect(timeEnd, `${what}'s time before the thread`).toBeLessThan(threadX);
      expect(title.getBoundingClientRect().left).toBeGreaterThan(threadX);
      // Wide, the holders take a third column; narrow, a line under the words.
      // An event holds no one.
      const holders = li.querySelector<HTMLElement>(".run-sheet-holders");
      const at = holders?.getBoundingClientRect();
      const words = title.getBoundingClientRect();
      const placed =
        li.dataset.kind === "event"
          ? holders === null
          : at !== undefined && (wide ? at.left >= words.right : at.top >= words.bottom);
      expect(placed, `${what}'s holders ${wide ? "beside" : "under"} its words`).toBe(true);
    }
  }
}

/** Every word on the sheet reads at 4.5:1 on what it is painted over, and the
 *  reader's bar at 3:1. */
function expectReadable() {
  const sheet = document.querySelector("[data-run-sheet]")!;
  for (const el of wordsIn(sheet)) {
    const measured = ratioOn(el, getComputedStyle(el).color);
    expect(
      measured,
      `"${el.textContent}" reads at ${measured.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
  }
  for (const li of document.querySelectorAll<HTMLElement>("[data-own]")) {
    const bar = getComputedStyle(li, "::before");
    expect(parseFloat(bar.width)).toBeGreaterThanOrEqual(2);
    const measured = ratioOn(li, bar.backgroundColor);
    expect(measured, `the reader's bar at ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      WCAG_UI_MIN,
    );
  }
}

beforeEach(async () => {
  __resetRunSheetCache();
  authFetch.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await commands.servePhotos();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.theme;
});

describe("the run sheet, painted", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`lays out an owner's whole day — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        await show(OWNER, { canEdit: true, helper: false });

        // Two days and the untimed tasks, each a headed list.
        expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
          "Saturday 20 June",
          "Sunday 21 June",
          "Any time on the day",
        ]);
        // One zone on the first day, said once; two on the second, said per row.
        expect(screen.getByText("Times in AEST")).toBeTruthy();
        expect(screen.getByText("Each time on its own clock")).toBeTruthy();
        expect(within(rowOf("nani")).getByText("GMT+5:30")).toBeTruthy();
        expect(within(rowOf("hair")).queryByText("AEST")).toBeNull();
        // The flags, each where it belongs.
        expect(rowOf("greet").hasAttribute("data-coming-up")).toBe(true);
        expect(within(rowOf("greet")).getByText("Coming up")).toBeTruthy();
        expect(within(rowOf("rings")).getByText("You")).toBeTruthy();
        expect(within(rowOf("cake")).getByText("Event removed")).toBeTruthy();
        expect(
          getComputedStyle(within(rowOf("hair")).getByText("Hair and makeup for the bridal party"))
            .textDecorationLine,
        ).toBe("line-through");
        expect(rowOf("rings").textContent).toContain("At the start of Ceremony");
        expect(rowOf("dance").textContent).toContain("3 hr 30 min after Reception");
        expect(rowOf("evt_reception").textContent).toMatch(/to 12:30\sam Sun/);
        // The Reception's run of show, from its start, after midnight last.
        const runOfShow = within(rowOf("evt_reception")).getByRole("list", {
          name: "Run of show for Reception",
        });
        expect(
          [...runOfShow.querySelectorAll("[data-run-of-show-item]")].map((li) =>
            (li.textContent ?? "").replace(/\s+/g, " ").trim(),
          ),
        ).toEqual([
          "5:30 pm Guests seated",
          "6:15 pm Entrée, then the speeches from both families and a toast to the couple's parents",
          "10:45 pm Sparklers send-off",
          "12:15 am Last bus to the city (after midnight)",
        ]);
        // The row's own grid: three tracks once the view is wide.
        const tracks = getComputedStyle(rowOf("dance")).gridTemplateColumns.split(" ").length;
        expect(tracks).toBe(viewport.width >= 1000 ? 3 : 2);

        expectLaidOut(viewport.width);
        expectReadable();
        await page.screenshot({ path: shot(`owner-${viewport.name}-${theme}`) });
      });

      it(`lays out an own-scope helper's day — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        await show(HELPER, { canEdit: false, helper: true });

        expect(screen.getByText("Your tasks for the day")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /checklist/i })).toBeNull();
        expect(
          [...document.querySelectorAll("[data-own]")].map(
            (li) => (li as HTMLElement).dataset.runSheetItem,
          ),
        ).toEqual(["greet", "dance", "chairs"]);
        // The reader first among the faces, and named first.
        expect(rowOf("greet").textContent).toContain("Held by Tom Ellis and Ben Okafor");

        expectLaidOut(viewport.width);
        expectReadable();
        await page.screenshot({ path: shot(`helper-${viewport.name}-${theme}`) });
      });

      it(`tells a helper below Gold, plainly, and asks for nothing — ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        render(() => (
          <div style={{ padding: "16px" }}>
            <RunSheetView weddingId="wed_1" tier="ivory" callerRole="helper" canEdit={false} />
          </div>
        ));
        const words = screen.getByText("The run sheet isn't available for this wedding.");
        expect(authFetch).not.toHaveBeenCalled();
        const measured = ratioOn(words, getComputedStyle(words).color);
        expect(measured).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
        await page.screenshot({ path: shot(`below-gold-${viewport.name}-${theme}`) });
      });
    }
  }
});
