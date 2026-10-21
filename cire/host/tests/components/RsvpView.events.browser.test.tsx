import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The RSVP page shows one event at a time, picked from a tab list inside the
 * module shell's own tab panel, and its table keeps the head row and the Guest
 * column in view while the table scrolls in its own box. What only a real
 * engine can answer:
 *
 * - that the event tabs and the shell's sub-tabs share a document without an id
 *   meeting another, and that Chrome exposes both as tab lists;
 * - that the keyboard moves through the event tabs and selects only on Enter or
 *   Space, and that Tab leaves the strip for the panel;
 * - that a strip of many events scrolls sideways on its own, brings a focused
 *   or deep-linked tab into view, and never moves the page while it does;
 * - that a sort head says its order in `aria-sort` and orders the rows;
 * - that the sticky head, Guest column and corner stay put and stay on top
 *   while the box scrolls, at desktop and phone width;
 * - that the box fits on screen under the top bar, which is the condition the
 *   owner set for a table that scrolls inside the page.
 *
 * It renders the real `ModuleShell` on Guests → RSVPs, under a stand-in for
 * the page's sticky top bar with the same classes and heights. Screenshots land
 * in `__screenshots__/` beside this file (gitignored).
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/haptics", () => ({ haptic: () => {} }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
// One Reception reply changed since the last visit, so its tab says New.
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => ({
    markSeq: 1,
    rows: [{ guestId: "g1", eventId: "evt_reception" }],
  }),
  markRsvpChangesSeen: async () => {},
}));

import ModuleShell from "../../src/components/ModuleShell";
import { eventPayload, guestList } from "../test-support/rsvp-guests";

type Payload = { events: ReturnType<typeof eventPayload>[] };

const THREE: Payload = {
  events: [
    eventPayload("evt_ceremony", "Ceremony", guestList(900), 0),
    eventPayload("evt_reception", "Reception", guestList(300), 1),
    eventPayload("evt_brunch", "Farewell brunch", guestList(60), 2),
  ],
};

const TWELVE_NAMES = [
  "Welcome drinks",
  "Mehndi",
  "Haldi",
  "Sangeet",
  "Ceremony",
  "Cocktail hour",
  "Reception",
  "After party",
  "Day-two lunch",
  "Garden games",
  "Farewell brunch",
  "Airport transfers",
];
const TWELVE: Payload = {
  events: TWELVE_NAMES.map((name, i) => eventPayload(`evt_${i}`, name, guestList(12), i)),
};

const rowsOf = (payload: Payload, index = 0) =>
  payload.events[index]!.guests.length + payload.events[index]!.unresponded.length;

/** What the page wraps the shell in: the frame container, a sticky top bar
 *  with the real one's classes, and the page measure. */
function renderPage(
  payload: Payload,
  opts: { canEdit?: boolean; rsvpEvent?: string; onRsvpEvent?: (id: string) => void } = {},
) {
  authFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const [rsvpEvent, setRsvpEvent] = createSignal(opts.rsvpEvent);
  return render(() => (
    <div class="@container/frame">
      <header
        data-top-bar
        class="border-border bg-bg/85 sticky top-0 z-30 border-b backdrop-blur-md"
      >
        <div class="page-frame flex h-14 items-center gap-2 @2xl/frame:h-16">
          <span class="font-display text-text text-ui-md leading-none font-light">Cire</span>
        </div>
      </header>
      <main class="page-frame @container/page flex flex-col gap-8 py-8 @2xl/frame:py-10">
        <ModuleShell
          weddingId="wed_1"
          weddingName="Rosa & Viktor"
          weddingSlug="rosa-and-viktor"
          callerRole="owner"
          canManage
          canEdit={opts.canEdit ?? true}
          module="guests"
          sub="rsvps"
          onModule={() => {}}
          onSub={() => {}}
          rsvpEvent={rsvpEvent()}
          onRsvpEvent={(id) => {
            setRsvpEvent(id);
            opts.onRsvpEvent?.(id);
          }}
          tier="crimson"
          entitlements={[]}
          guestCap={1000}
        />
      </main>
    </div>
  ));
}

async function ready(rows: number) {
  await vi.waitFor(() => expect(document.querySelectorAll("tbody > tr")).toHaveLength(rows), {
    timeout: 5_000,
  });
  await document.fonts.ready;
}

const eventTabs = () => within(screen.getByRole("tablist", { name: "Events" })).getAllByRole("tab");
const eventTab = (name: string) =>
  within(screen.getByRole("tablist", { name: "Events" })).getByRole("tab", {
    name: new RegExp(`^${name},`),
  });
const strip = () => screen.getByRole("tablist", { name: "Events" });
const eventPanel = () =>
  document.getElementById(strip().querySelector("[role=tab]")!.getAttribute("aria-controls")!)!;
const box = () => document.querySelector("table")!.parentElement!;
const topBar = () => document.querySelector<HTMLElement>("[data-top-bar]")!;
const head = (name: string) =>
  [...document.querySelectorAll<HTMLTableCellElement>("thead th")].find((th) =>
    th.textContent?.trim().toLowerCase().startsWith(name.toLowerCase()),
  )!;
/** The surnames of the first `count` rows. The Guest cell draws
 *  `{firstName} {lastName}` as three text nodes, then its badges. */
const surnames = (count: number) =>
  [...document.querySelectorAll("tbody > tr > td:first-child")]
    .slice(0, count)
    .map((td) => td.childNodes[2]?.textContent?.trim());

/** What a utility class paints, read off a throwaway element. */
function probe(className: string, property: "color" | "backgroundColor"): string {
  const el = document.createElement("div");
  el.className = className;
  document.body.append(el);
  const value = getComputedStyle(el)[property];
  el.remove();
  return value;
}

/** Whether the element painted at a box's centre is that box or inside it;
 *  when not, the message names what is painted there instead. */
function expectOnTop(el: Element, what: string) {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const found = hit
    ? `<${hit.tagName.toLowerCase()}> "${hit.textContent?.trim().slice(0, 40)}"`
    : "nothing";
  expect(
    hit !== null && el.contains(hit),
    `${what} at (${Math.round(r.left)}, ${Math.round(r.top)}, ${Math.round(r.width)}x${Math.round(r.height)}) in a ${innerWidth}x${innerHeight} window is covered by ${found}`,
  ).toBe(true);
}

/** A row whose box sits wholly inside the scroll box, below its head row. */
function visibleRow(): HTMLTableRowElement {
  const outer = box().getBoundingClientRect();
  // A head cell, not the <thead>: the cells stick, the row group scrolls away.
  const headBottom = document.querySelector("thead th")!.getBoundingClientRect().bottom;
  return [...document.querySelectorAll<HTMLTableRowElement>("tbody > tr")].find((tr) => {
    const r = tr.getBoundingClientRect();
    return r.top >= headBottom + 1 && r.bottom <= outer.bottom - 1;
  })!;
}

beforeAll(() => {
  // A theme flip and a hover read colours: no transition may sit between.
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
});

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  delete document.documentElement.dataset.theme;
  window.scrollTo(0, 0);
});

interface AXNode {
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
}

interface Frame {
  frame: { id: string; url: string };
  childFrames?: Frame[];
}

/** Chrome's accessibility tree for the frame this test runs in. */
async function accessibilityTree(): Promise<AXNode[]> {
  const session = cdp();
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: Frame };
  const find = (node: Frame): Frame | undefined =>
    node.frame.url === location.href ? node : node.childFrames?.map(find).find(Boolean);
  const own = find(frameTree);
  if (!own) throw new Error(`no frame at ${location.href}`);
  const { nodes } = (await session.send("Accessibility.getFullAXTree", {
    frameId: own.frame.id,
  })) as { nodes: AXNode[] };
  return nodes;
}

describe("the RSVP page's event tabs", () => {
  it("sit inside the module's tab panel, with ids that never meet the shell's", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));

    // The shell's own strip and panel are there, and the event strip is inside
    // that panel.
    const views = screen.getByRole("tablist", { name: "Views" });
    const modulePanel = document.getElementById("subpanel-guests")!;
    expect(modulePanel.getAttribute("aria-labelledby")).toBe("subtab-guests-rsvps");
    expect(modulePanel.contains(strip())).toBe(true);
    expect(views.contains(strip())).toBe(false);

    // No id repeats, and every reference names an element that exists.
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const refs = [...document.querySelectorAll("[aria-controls], [aria-labelledby]")].flatMap(
      (el) =>
        `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-labelledby") ?? ""}`
          .split(/\s+/)
          .filter(Boolean),
    );
    expect(refs.filter((id) => document.getElementById(id) === null)).toEqual([]);
    for (const tab of eventTabs()) {
      expect(tab.id.startsWith("subtab-")).toBe(false);
      expect(tab.getAttribute("aria-controls")?.startsWith("subpanel-")).toBe(false);
    }

    // One event panel, labelled by the chosen tab.
    expect(eventTabs().map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(eventPanel().getAttribute("role")).toBe("tabpanel");
    expect(eventPanel().getAttribute("aria-labelledby")).toBe(eventTabs()[0]!.id);

    // Chrome exposes both strips as tab lists, and names each event tab by its
    // event and its count, as written rather than in the label's capitals.
    const nodes = await accessibilityTree();
    const tabNames = nodes
      .filter((node) => !node.ignored && node.role?.value === "tab")
      .map((node) => node.name?.value);
    expect(tabNames.slice(3)).toEqual([
      `Ceremony, ${rowsOf(THREE, 0)} guests`,
      `Reception, ${rowsOf(THREE, 1)} guests, changed since you last looked`,
      `Farewell brunch, ${rowsOf(THREE, 2)} guests`,
    ]);
    expect(nodes.filter((node) => !node.ignored && node.role?.value === "tablist")).toHaveLength(2);
  });

  it("moves focus with the arrows and chooses only on Enter or Space", async () => {
    await page.viewport(1280, 800);
    const chosen: string[] = [];
    renderPage(THREE, { onRsvpEvent: (id) => chosen.push(id) });
    await ready(rowsOf(THREE));
    const [ceremony, reception, brunch] = eventTabs();

    // Only the chosen tab is a tab stop.
    expect(eventTabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    ceremony!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(reception);
    expect(ceremony!.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(brunch);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(ceremony);
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(brunch);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(ceremony);
    // Passing over a tab chose nothing and drew nothing new.
    expect(chosen).toEqual([]);
    expect(document.querySelectorAll("tbody > tr")).toHaveLength(rowsOf(THREE, 0));

    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(reception!.getAttribute("aria-selected")).toBe("true");
    expect(chosen).toEqual(["evt_reception"]);
    // What a sighted host sees of the choice: the pill sits on the chosen tab,
    // and its label is in gold while the others are not.
    const pill = strip().querySelector<HTMLElement>(":scope > span[aria-hidden]")!;
    await vi.waitFor(() => {
      const p = pill.getBoundingClientRect();
      const t = reception!.getBoundingClientRect();
      const gaps = [p.left - t.left, p.top - t.top, p.width - t.width, p.height - t.height];
      expect(gaps.every((gap) => Math.abs(gap) <= 1)).toBe(true);
    });
    expect(getComputedStyle(reception!).color).toBe(probe("text-gold", "color"));
    expect(getComputedStyle(ceremony!).color).not.toBe(probe("text-gold", "color"));
    await vi.waitFor(() =>
      expect(document.querySelectorAll("tbody > tr")).toHaveLength(rowsOf(THREE, 1)),
    );
    expect(eventPanel().getAttribute("aria-labelledby")).toBe(reception!.id);

    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard(" ");
    expect(brunch!.getAttribute("aria-selected")).toBe("true");
    expect(chosen).toEqual(["evt_reception", "evt_brunch"]);

    // Tab leaves the strip for the panel: its search box comes next.
    await userEvent.tab();
    expect(document.activeElement).toBe(
      within(eventPanel()).getByRole("searchbox", { name: "Search Farewell brunch guests" }),
    );
  });

  it("scrolls a strip of many events sideways, by itself, without moving the page", async () => {
    await page.viewport(390, 844);
    renderPage(TWELVE, { rsvpEvent: "evt_10" });
    await ready(rowsOf(TWELVE, 10));

    // The strip overflows and scrolls; its box stays inside the page measure.
    const track = strip();
    expect(track.scrollWidth).toBeGreaterThan(track.clientWidth);
    const main = document.querySelector("main")!.getBoundingClientRect();
    expect(track.getBoundingClientRect().right).toBeLessThanOrEqual(main.right);

    // A deep-linked tab far along the strip was brought into it on load, and
    // the page itself did not move.
    const inStrip = (tab: Element) => {
      const t = tab.getBoundingClientRect();
      const s = track.getBoundingClientRect();
      return t.left >= s.left - 0.5 && t.right <= s.right + 0.5;
    };
    expect(track.scrollLeft).toBeGreaterThan(0);
    expect(inStrip(eventTab("Farewell brunch"))).toBe(true);
    expect(window.scrollY).toBe(0);

    // Home takes focus to a tab now off the strip's left edge, and brings it in.
    eventTab("Farewell brunch").focus({ preventScroll: true });
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(eventTab("Welcome drinks"));
    expect(inStrip(eventTab("Welcome drinks"))).toBe(true);
    await userEvent.keyboard("{End}");
    expect(inStrip(eventTab("Airport transfers"))).toBe(true);
    expect(window.scrollY).toBe(0);

    await page.screenshot({
      path: "__screenshots__/RsvpView.events.browser.test.tsx/strip-12-events-390.png",
    });
  });

  it("brings a tab mid-strip just into view, and leaves the strip alone for one in view", async () => {
    await page.viewport(390, 844);
    renderPage(TWELVE, { rsvpEvent: "evt_5" });
    await ready(rowsOf(TWELVE, 5));
    const track = strip();
    const inner = () => {
      const r = track.getBoundingClientRect();
      return {
        left: r.left + track.clientLeft,
        right: r.left + track.clientLeft + track.clientWidth,
      };
    };
    const inStrip = (tab: Element) => {
      const t = tab.getBoundingClientRect();
      return t.left >= inner().left - 0.5 && t.right <= inner().right + 0.5;
    };

    // A deep link to the middle of the strip lands with the tab at its end
    // edge, inside the track's 4px padding — not scrolled past it. Within a
    // pixel: the strip scrolls by `offsetLeft` and `offsetWidth`, which are
    // whole pixels, while a label's box need not be (it is not on CI's fonts).
    const cocktails = eventTab("Cocktail hour");
    const gap = inner().right - cocktails.getBoundingClientRect().right;
    expect(gap).toBeGreaterThanOrEqual(3);
    expect(gap).toBeLessThanOrEqual(5);
    expect(track.scrollLeft).toBeLessThan(track.scrollWidth - track.clientWidth);

    // Arrowing to a neighbour already in view does not move the strip.
    const ceremony = eventTab("Ceremony");
    expect(inStrip(ceremony)).toBe(true);
    const before = track.scrollLeft;
    cocktails.focus({ preventScroll: true });
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(ceremony);
    expect(track.scrollLeft).toBe(before);

    // Arrowing on past the edge brings each tab in as it gets focus.
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toBe(eventTab("Reception"));
    expect(inStrip(eventTab("Reception"))).toBe(true);
    await userEvent.keyboard("{ArrowRight}");
    expect(inStrip(eventTab("After party"))).toBe(true);

    // The keys the strip uses are its own: Home does not also scroll the page.
    window.scrollTo(0, 120);
    expect(window.scrollY).toBe(120);
    eventTab("After party").focus({ preventScroll: true });
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(eventTab("Welcome drinks"));
    expect(window.scrollY).toBe(120);
  });
});

describe("the RSVP table's sort heads", () => {
  it("sort by surname or household, both ways, and say so in aria-sort", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    const sortedBy = (xs: (string | undefined)[], direction: 1 | -1) =>
      xs.every((x, i) => i === 0 || direction * collator.compare(xs[i - 1]!, x!) <= 0);

    // Nothing sorted: the API's order, which the surname check below must
    // fail, and no head claims an order. Both heads offer one.
    expect(surnames(40).every(Boolean)).toBe(true);
    expect(sortedBy(surnames(40), 1)).toBe(false);
    expect(head("Guest").hasAttribute("aria-sort")).toBe(false);
    expect(head("Household").hasAttribute("aria-sort")).toBe(false);
    expect(head("Guest").querySelector("svg.lucide-chevrons-up-down")).not.toBeNull();

    const guestButton = within(head("Guest")).getByRole("button", { name: "Guest" });
    // The label is in capitals like every head, though a button does not
    // inherit the head's transform.
    expect(getComputedStyle(guestButton).textTransform).toBe("uppercase");

    await userEvent.click(guestButton);
    expect(head("Guest").getAttribute("aria-sort")).toBe("ascending");
    expect(sortedBy(surnames(40), 1)).toBe(true);
    expect(head("Guest").querySelector("svg.lucide-arrow-up")).not.toBeNull();
    expect(head("Household").querySelector("svg.lucide-chevrons-up-down")).not.toBeNull();

    await userEvent.click(guestButton);
    expect(head("Guest").getAttribute("aria-sort")).toBe("descending");
    expect(sortedBy(surnames(40), -1)).toBe(true);
    expect(head("Guest").querySelector("svg.lucide-arrow-down")).not.toBeNull();

    // The keyboard sorts the other head; only one head says it is sorted.
    const householdButton = within(head("Household")).getByRole("button", { name: "Household" });
    householdButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(head("Household").getAttribute("aria-sort")).toBe("ascending");
    expect(head("Guest").hasAttribute("aria-sort")).toBe(false);
    const households = [...document.querySelectorAll("tbody > tr > td:nth-child(2)")]
      .slice(0, 40)
      .map((td) => td.textContent?.trim());
    expect(sortedBy(households, 1)).toBe(true);

    // The sort stays when the event changes.
    await userEvent.click(eventTab("Reception"));
    await vi.waitFor(() =>
      expect(document.querySelectorAll("tbody > tr")).toHaveLength(rowsOf(THREE, 1)),
    );
    expect(head("Household").getAttribute("aria-sort")).toBe("ascending");
  });
});

describe("the RSVP table's sticky head and Guest column", () => {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    it(`fits the whole box on screen under the top bar at ${width}px`, async () => {
      await page.viewport(width, height);
      renderPage(THREE);
      await ready(rowsOf(THREE));
      const bar = topBar().getBoundingClientRect().height;
      expect(box().getBoundingClientRect().height).toBeLessThanOrEqual(innerHeight - bar);
      // Scrolled so the box's top meets the bar's bottom edge, the box's own
      // bottom is on screen: the whole table, head row included, at once.
      // (Or as far as the page goes: the box is the last thing on it.)
      window.scrollTo(0, box().getBoundingClientRect().top + scrollY - bar);
      expect(box().getBoundingClientRect().top).toBeGreaterThanOrEqual(bar - 0.5);
      expect(box().getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
    });
  }

  it("shows rows on a laptop's first screen, before any scroll", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const firstRow = document.querySelector("tbody > tr")!.getBoundingClientRect();
    expect(firstRow.bottom).toBeLessThan(innerHeight);
  });

  it("holds the head row at the top of the box while the rows scroll under it", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const scroller = box();
    scroller.scrollTop = 2000;
    expect(scroller.scrollTop).toBe(2000);
    const top = scroller.getBoundingClientRect().top + scroller.clientTop;
    for (const name of ["Guest", "Household", "Status", "Dietary"]) {
      expect([name, Math.abs(head(name).getBoundingClientRect().top - top) < 1]).toEqual([
        name,
        true,
      ]);
      expectOnTop(head(name), `the ${name} head`);
    }
    // At this width the table needs no sideways scroll, so the Guest column
    // is not pinned: 900 pinned cells would cost every scrolled frame for a
    // column that cannot slide.
    expect(scroller.scrollWidth).toBe(scroller.clientWidth);
    expect(getComputedStyle(visibleRow().querySelector("td")!).position).toBe("static");

    // Moving to another event puts the box back at its top.
    await userEvent.click(eventTab("Reception"));
    await vi.waitFor(() =>
      expect(document.querySelectorAll("tbody > tr")).toHaveLength(rowsOf(THREE, 1)),
    );
    expect(box().scrollTop).toBe(0);
  });

  it("holds the Guest column at the box's left edge on a phone, under the corner", async () => {
    await page.viewport(390, 844);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    // The page scrolled so the box is on screen under the bar, as a host would.
    window.scrollTo(0, box().getBoundingClientRect().top + scrollY - topBar().offsetHeight);
    const scroller = box();
    scroller.scrollTop = 1200;
    scroller.scrollLeft = 260;
    expect(scroller.scrollLeft).toBe(260);
    const left = scroller.getBoundingClientRect().left + scroller.clientLeft;

    const row = visibleRow();
    const [guest, household] = row.querySelectorAll("td");
    expect(getComputedStyle(guest!).position).toBe("sticky");
    expect(Math.abs(guest!.getBoundingClientRect().left - left)).toBeLessThan(1);
    // The Household cell has slid under the Guest cell, which paints on top.
    expect(household!.getBoundingClientRect().left).toBeLessThan(
      guest!.getBoundingClientRect().right,
    );
    expectOnTop(guest!, "the Guest cell");
    // The corner holds both ways and covers what passes beneath it.
    expect(head("Guest").getBoundingClientRect().left).toBeCloseTo(left, 0);
    expectOnTop(head("Guest"), "the corner");
    expectOnTop(head("Dietary"), "the Dietary head");

    // A row's hover fill reaches its pinned cell too.
    const surface = probe("bg-surface", "backgroundColor");
    await userEvent.hover(guest!);
    expect(getComputedStyle(guest!).backgroundColor).toBe(surface);
  });

  it("keeps a focused control clear of the pinned head row and Guest column", async () => {
    // Keyboard focus that lands under an opaque pinned cell is focus nobody
    // can see. The box's scroll padding is what keeps it clear.
    await page.viewport(390, 844);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    window.scrollTo(0, box().getBoundingClientRect().top + scrollY - topBar().offsetHeight);
    const scroller = box();

    // Rows scrolled well past an Edit button, then focus moves back to it.
    const buttons = [...scroller.querySelectorAll<HTMLButtonElement>("tbody button")];
    const target = buttons[30]!;
    scroller.scrollTop =
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 600;
    scroller.scrollLeft = scroller.scrollWidth;
    target.focus();
    expect(document.activeElement).toBe(target);
    expectOnTop(target, "the focused Edit button");

    // The head row's second sort button, after the box has gone sideways.
    scroller.scrollLeft = scroller.scrollWidth;
    const household = within(head("Household")).getByRole("button", { name: "Household" });
    household.focus();
    expect(document.activeElement).toBe(household);
    expectOnTop(household, "the focused Household sort button");
  });

  for (const theme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [1280, 800],
      [390, 844],
    ] as const) {
      it(`is drawn scrolled, in the ${theme} theme at ${width}px`, async () => {
        document.documentElement.dataset.theme = theme;
        await page.viewport(width, height);
        renderPage(THREE);
        await ready(rowsOf(THREE));
        const dir = "__screenshots__/RsvpView.events.browser.test.tsx";
        await page.screenshot({ path: `${dir}/${theme}-${width}-first-screen.png` });
        await userEvent.click(within(head("Guest")).getByRole("button", { name: "Guest" }));
        const bar = topBar().getBoundingClientRect().height;
        window.scrollTo(0, box().getBoundingClientRect().top + scrollY - bar);
        box().scrollTop = 1400;
        box().scrollLeft = width === 390 ? 220 : 0;
        // What the picture shows: the head row still at the top of the box,
        // the rows sorted under it.
        expect(head("Guest").getAttribute("aria-sort")).toBe("ascending");
        expect(head("Guest").getBoundingClientRect().top).toBeCloseTo(
          box().getBoundingClientRect().top + box().clientTop,
          0,
        );
        await page.screenshot({ path: `${dir}/${theme}-${width}-table-scrolled.png` });
      });
    }
  }
});
