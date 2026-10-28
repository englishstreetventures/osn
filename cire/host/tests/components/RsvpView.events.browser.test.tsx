import { cleanup, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The RSVP page shows one event at a time, picked from a tab list the view
 * lends the module shell's view bar, and its table scrolls with the page with
 * its head row stuck under that bar. What only a real engine can answer:
 *
 * - that the event tabs and the shell's sub-tabs share a document without an id
 *   meeting another, sit together in the bar outside the module's tab panel,
 *   and that Chrome exposes both as tab lists;
 * - that the keyboard moves through the event tabs and selects only on Enter or
 *   Space, and that Tab leaves the strip for the search beside it;
 * - that a strip of many events scrolls sideways on its own, brings a focused
 *   or deep-linked tab into view, and never moves the page while it does;
 * - that a sort head says its order in `aria-sort` and orders the rows;
 * - that the head row sticks under the view bar and stays on top while the page
 *   scrolls, and that a phone draws stacked rows instead of a table, sorts
 *   them from a select and records a reply in a block under the guest;
 * - that a chip focused from the keyboard wears the focus ring, whole;
 * - that the reply key opens from the keyboard and names every mark a guest's
 *   meta line can carry.
 *
 * The whole stack — every Guests tab, both sizes, focus, search and sub-tab
 * moves — is measured in `GuestsStack.browser.test.tsx`. It renders the real
 * `ModuleShell` on Guests → RSVPs through `test-support/organiser-page.tsx`.
 * Screenshots land in `__screenshots__/` beside this file (gitignored).
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/haptics", () => ({ haptic: () => {}, hapticsAvailable: () => false }));
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

import { renderOrganiserPage, routeFetch, topBar } from "../test-support/organiser-page";
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

/** The page on Guests → RSVPs, its RSVP read answering with `payload`. */
function renderPage(
  payload: Payload,
  opts: { canEdit?: boolean; rsvpEvent?: string; onRsvpEvent?: (id: string) => void } = {},
) {
  routeFetch(authFetch, { rsvps: payload });
  return renderOrganiserPage({
    module: "guests",
    sub: "rsvps",
    canEdit: opts.canEdit ?? true,
    rsvpEvent: opts.rsvpEvent,
    onRsvpEvent: opts.onRsvpEvent,
  });
}

/** A guest row: a table row on a wide panel, a block on a narrow one. */
const ROWS = 'tbody > tr, ul[aria-label^="Replies"] > li';

async function ready(rows: number) {
  await vi.waitFor(() => expect(document.querySelectorAll(ROWS)).toHaveLength(rows), {
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
const viewBar = () => document.querySelector<HTMLElement>("[data-view-bar]")!;
const head = (name: string) =>
  [...document.querySelectorAll<HTMLTableCellElement>("thead th")].find((th) =>
    th.textContent?.trim().toLowerCase().startsWith(name.toLowerCase()),
  )!;
/** The surnames of the first `count` rows. The Guest cell draws
 *  `{firstName} {lastName}` as three text nodes, then its badges. */
const surnames = (count: number) =>
  [...document.querySelectorAll("tbody > tr > td:first-child [data-name]")]
    .slice(0, count)
    .map((name) => name.childNodes[2]?.textContent?.trim());

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
  it("sit in the module's view bar beside its sub-tabs, with ids that never meet the shell's", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));

    // The shell's own strip and panel are there. The event strip is in the
    // view bar with it — a landmark named for the module — and outside the
    // module's tab panel, which the sub-tabs still control.
    const views = screen.getByRole("tablist", { name: "Views" });
    const modulePanel = document.getElementById("subpanel-guests")!;
    const bar = screen.getByRole("region", { name: "Guests controls" });
    expect(modulePanel.getAttribute("aria-labelledby")).toBe("subtab-guests-rsvps");
    expect(bar.contains(strip())).toBe(true);
    expect(bar.contains(views)).toBe(true);
    expect(modulePanel.contains(strip())).toBe(false);
    expect(views.contains(strip())).toBe(false);
    for (const tab of within(views).getAllByRole("tab")) {
      expect(tab.getAttribute("aria-controls")).toBe("subpanel-guests");
    }
    // The search beside the strip acts on the event on screen, and names its
    // panel to say so.
    expect(
      screen
        .getByRole("searchbox", { name: "Search Ceremony guests" })
        .getAttribute("aria-controls"),
    ).toBe(eventPanel().id);

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
    // What a sighted host sees of the choice: the chosen chip fills in the
    // brand green, in its own ink, while the others stay on the surface.
    expect(getComputedStyle(reception!).backgroundColor).toBe(probe("bg-brand", "backgroundColor"));
    expect(getComputedStyle(reception!).color).toBe(probe("text-on-brand", "color"));
    expect(getComputedStyle(ceremony!).backgroundColor).toBe(
      probe("bg-surface", "backgroundColor"),
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll("tbody > tr")).toHaveLength(rowsOf(THREE, 1)),
    );
    expect(eventPanel().getAttribute("aria-labelledby")).toBe(reception!.id);

    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard(" ");
    expect(brunch!.getAttribute("aria-selected")).toBe("true");
    expect(chosen).toEqual(["evt_reception", "evt_brunch"]);

    // Tab leaves the strip for the search box beside it, in the same bar.
    await userEvent.tab();
    expect(document.activeElement).toBe(
      within(viewBar()).getByRole("searchbox", { name: "Search Farewell brunch guests" }),
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
    // A small tablet: the strip shares the bar's row with the sub-tabs, and at
    // this width it holds two tabs side by side while still overflowing.
    await page.viewport(600, 844);
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

describe("the RSVP table's stuck head row", () => {
  it("shows rows on a laptop's first screen, before any scroll", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const firstRow = document.querySelector("tbody > tr")!.getBoundingClientRect();
    expect(firstRow.bottom).toBeLessThan(innerHeight);
  });

  it("holds the head row under the view bar while the page scrolls the rows under it", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    window.scrollTo(0, 6000);
    expect(window.scrollY).toBe(6000);
    const foot = viewBar().getBoundingClientRect().bottom;
    expect(viewBar().getBoundingClientRect().top).toBeCloseTo(
      topBar().getBoundingClientRect().bottom,
      0,
    );
    for (const name of ["Guest", "Household", "Status", "Dietary"]) {
      expect([name, Math.abs(head(name).getBoundingClientRect().top - foot) < 1]).toEqual([
        name,
        true,
      ]);
      expectOnTop(head(name), `the ${name} head`);
    }
    // The page is what scrolls: the table is clipped, never a scroll box.
    const box = document.querySelector("table")!.parentElement!;
    expect(getComputedStyle(box).overflowX).toBe("clip");
    expect(box.scrollWidth).toBe(box.clientWidth);
    expect(getComputedStyle(document.querySelector("tbody td")!).position).toBe("static");
  });

  it("draws stacked rows on a phone, with nothing to scroll sideways", async () => {
    await page.viewport(390, 844);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    expect(document.querySelector("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Replies for Ceremony" });
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    // The sort is a select in the bar; the reply filter its row of chips.
    expect(within(viewBar()).getByRole("combobox", { name: "Sort guests" })).toBeTruthy();
    const replies = within(viewBar()).getByRole("group", { name: "Filter Ceremony by reply" });
    expect(within(replies).getAllByRole("button")).toHaveLength(5);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`is drawn scrolled and sorted, in the ${theme} theme at 1280px`, async () => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(1280, 800);
      renderPage(THREE);
      await ready(rowsOf(THREE));
      const dir = "__screenshots__/RsvpView.events.browser.test.tsx";
      await screenshotWindow(`${dir}/${theme}-1280-first-screen.png`);
      await userEvent.click(within(head("Guest")).getByRole("button", { name: "Guest" }));
      expect(head("Guest").getAttribute("aria-sort")).toBe("ascending");
      window.scrollTo(0, 4000);
      // What the picture shows: the bar under the top bar, the head row under
      // the bar, the rows sorted beneath.
      expect(viewBar().getBoundingClientRect().top).toBeCloseTo(
        topBar().getBoundingClientRect().bottom,
        0,
      );
      expect(head("Guest").getBoundingClientRect().top).toBeCloseTo(
        viewBar().getBoundingClientRect().bottom,
        0,
      );
      await screenshotWindow(`${dir}/${theme}-1280-scrolled.png`);
    });

    it(`is drawn scrolled, in the ${theme} theme at 390px`, async () => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(390, 844);
      renderPage(THREE);
      await ready(rowsOf(THREE));
      const dir = "__screenshots__/RsvpView.events.browser.test.tsx";
      await screenshotWindow(`${dir}/${theme}-390-first-screen.png`);
      window.scrollTo(0, 4000);
      expect(viewBar().getBoundingClientRect().top).toBeCloseTo(
        topBar().getBoundingClientRect().bottom,
        0,
      );
      await screenshotWindow(`${dir}/${theme}-390-scrolled.png`);
    });
  }
});

describe("the RSVP page on a phone", () => {
  /** Each stacked row's household, top to bottom. */
  const households = () =>
    [...document.querySelectorAll('ul[aria-label^="Replies"] > li [data-name] + span')].map(
      (el) => el.textContent?.trim() ?? "",
    );

  it("sorts the stacked rows from the bar's select", async () => {
    await page.viewport(390, 844);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const select = within(viewBar()).getByRole("combobox", { name: "Sort guests" });
    await userEvent.selectOptions(select, "household:descending");
    await vi.waitFor(() => {
      const names = households();
      expect(names.length).toBe(rowsOf(THREE));
      expect(names[0]!.localeCompare(names.at(-1)!)).toBeGreaterThan(0);
    });
    await userEvent.selectOptions(select, "household:ascending");
    await vi.waitFor(() => {
      const names = households();
      expect(names[0]!.localeCompare(names.at(-1)!)).toBeLessThan(0);
    });
  });

  it("records a reply in a block under the guest, dietary consent and all", async () => {
    await page.viewport(390, 844);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const record = screen.getAllByRole("button", { name: /^Record reply for / })[0]!;
    const guest = record.getAttribute("aria-label")!.replace("Record reply for ", "");
    const row = record.closest("li")!;
    await userEvent.click(record);
    // The editor opens inside the guest's own block, its picker inline.
    const presets = await vi.waitFor(() =>
      within(row).getByRole("group", { name: `Dietary requirements for ${guest}` }),
    );
    // The pill is the label; its checkbox is hidden under it.
    await userEvent.click(within(presets).getByText("Vegetarian"));
    expect(
      (within(presets).getByRole("checkbox", { name: /Vegetarian/ }) as HTMLInputElement).checked,
    ).toBe(true);
    const puts = () =>
      authFetch.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
      );
    // A preset is dietary data: saving it needs the consent box ticked.
    await userEvent.click(within(row).getByRole("button", { name: /Save reply/ }));
    await vi.waitFor(() =>
      expect(within(row).getByText(/consented before storing dietary requirements/)).toBeTruthy(),
    );
    expect(puts()).toEqual([]);
    await userEvent.click(within(row).getByRole("checkbox", { name: /consent/i }));
    await userEvent.click(within(row).getByRole("button", { name: /Save reply/ }));
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    const [url, init] = puts()[0]!;
    expect(String(url)).toMatch(/\/guests\/[^/]+\/rsvps\/evt_ceremony$/);
    const body = JSON.parse(String((init as RequestInit).body)) as {
      dietaryPresets: string[];
      dietaryConsent: boolean;
    };
    expect(body.dietaryPresets).toEqual(["vegetarian"]);
    expect(body.dietaryConsent).toBe(true);
  });
});

describe("the chips' focus ring", () => {
  /** Whether `el`'s ring — its outline, offset and width — lies inside `box`. */
  function ringInside(el: Element, box: Element): boolean {
    const style = getComputedStyle(el);
    const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return (
      r.top - reach >= b.top - 0.5 &&
      r.bottom + reach <= b.bottom + 0.5 &&
      r.left - reach >= b.left - 0.5
    );
  }

  it("shows whole on an event chip and a reply chip reached from the keyboard", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const [ceremony, reception] = eventTabs();
    ceremony!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(reception);
    expect(getComputedStyle(reception!).outlineStyle).toBe("solid");
    expect(parseFloat(getComputedStyle(reception!).outlineWidth)).toBeGreaterThanOrEqual(2);
    // Not cut by the strip, which scrolls sideways and so clips on both axes.
    expect(ringInside(reception!, strip())).toBe(true);

    const replies = within(viewBar()).getByRole("group", { name: /^Filter .* by reply$/ });
    within(viewBar()).getByRole("searchbox").focus();
    await userEvent.keyboard("{Tab}");
    const chip = document.activeElement!;
    expect(replies.contains(chip)).toBe(true);
    expect(getComputedStyle(chip).outlineStyle).toBe("solid");
    expect(ringInside(chip, replies)).toBe(true);
  });
});

describe("the reply key", () => {
  it("opens from the keyboard on every mark a meta line can carry, and gives focus back", async () => {
    await page.viewport(1280, 800);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const key = within(viewBar()).getByRole("button", { name: "What the reply icons mean" });
    // One stop for the whole page: the marks in the rows are none.
    expect(
      document.querySelectorAll("tbody [data-provenance] button, tbody button[data-tip]"),
    ).toHaveLength(0);
    key.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "What the reply icons mean" });
    for (const words of [
      "Changed by the guest since you last looked",
      "Host-entered",
      "Recorded by a host (phone/paper RSVP)",
      "Host-updated",
      "Household-entered",
      "linked musubi",
      "Sent from a signed-in linked musubi account",
    ]) {
      expect([words, dialog.textContent?.includes(words)]).toEqual([words, true]);
    }
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(key);
  });

  it("sits in the phone's search row at the search box's height", async () => {
    await page.viewport(390, 844);
    renderPage(THREE);
    await ready(rowsOf(THREE));
    const key = within(viewBar()).getByRole("button", { name: "What the reply icons mean" });
    const search = within(viewBar()).getByRole("searchbox");
    expect(
      Math.abs(key.getBoundingClientRect().height - search.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(key.getBoundingClientRect().top - search.getBoundingClientRect().top),
    ).toBeLessThanOrEqual(0.5);
  });
});

/** A picture of the window, not the whole page: an element screenshot of a
 *  box fixed over the viewport. */
async function screenshotWindow(path: string) {
  const frame = document.createElement("div");
  frame.style.cssText = "position:fixed;inset:0;pointer-events:none";
  document.body.append(frame);
  await page.screenshot({ path, element: frame });
  frame.remove();
}
