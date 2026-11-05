import Loading from "@cire/ui/loading";
import Skeleton from "@cire/ui/skeleton";
import SkeletonOutline from "@cire/ui/skeleton-outline";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Each view's loading placeholders against the content that replaces them, in
 * the real `ModuleShell` under the real `TopBar` (`test-support/organiser-page.tsx`),
 * at the size a wedding reaches (`guests-300`).
 *
 * Two kinds of placeholder (cire/host/DESIGN.md §4). The RSVP replies, the
 * households and the overview draw their own rows hollow from typed samples
 * (`SkeletonOutline`, the owner's answer on #1955); the event cards, the two
 * editors and the co-hosts hold each row's height with a `Skeleton` block (the
 * owner's answer on #1837). Each view's read is held back by a gate; the
 * placeholders are measured, the gate opens, and the content is measured. What
 * is checked:
 *
 * - a hollow view's outline stands where its content lands, and its first bar
 *   where the content's first line of text does, to 2px, at 1280px and 390px;
 *   its frames, hairlines and grounds — a card, a table's frame and head, a
 *   household's bar, a ruled row — keep the loaded colours;
 * - a block view's first placeholder stands where the first item lands, at
 *   1280px and 390px, so nothing under it moves: a section intro's actions are
 *   held as empty room; at 1280px each placeholder is the height of the item
 *   it stands for (the first, in a list whose items differ), and a list of them
 *   is spaced as the list it stands for, to 2px;
 * - the view bar is the same height while the RSVP replies load as after, at
 *   1280px and at 390px, and its divider stands where the loaded one does;
 * - `aria-busy` marks the region that holds the placeholders while it loads,
 *   and is gone once the content lands. Nothing in it that a reader could
 *   reach — a control, a heading, a form, a live region — is reachable: each
 *   sits under an `inert`, `aria-hidden` outline and refuses focus. Left empty
 *   by a failed read, the region takes no room and adds no gap;
 * - under reduced motion the loaders' pulse stops after one 0.01ms run, on a
 *   `Skeleton` block, a `Loading` line and an outline's bar alike.
 *
 * Artifacts: `cire/host/.vitest/skeletons/results.json`, one pass or fail per
 * named check, with no pixel values so a rerun writes the same file;
 * `measurements.json` beside it, the boxes, heights and gaps read on this
 * machine; and a picture of the window per view, width and theme, loading and
 * loaded, in `__screenshots__/` beside this file, taken under reduced motion so
 * every placeholder is at rest. All are gitignored.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch, activeProfileId: () => "usr_amy" }),
}));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/touch-feedback", () => ({
  haptic: () => {},
  hapticsAvailable: () => false,
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => null,
  markRsvpChangesSeen: async () => {},
}));
vi.mock("../../src/lib/osn", () => ({
  CIRE_API_URL: "https://api.test",
  CIRE_WEB_URL: "https://guests.test",
  CIRE_MARKETING_URL: "https://cire.test",
}));
vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [{ id: "classic", name: "Classic", tier: "free" }],
  DEFAULT_DESIGN_ID: "classic",
}));

import type { Module } from "../../src/lib/dashboard-route";
import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { EVENTS_300, GUESTS_300, HOUSEHOLDS_300, RSVPS_300 } from "../test-support/guests-300";
import { renderOrganiserPage } from "../test-support/organiser-page";

const HOSTS = [
  { hostId: "whost_amy", osnProfileId: "usr_amy", handle: "amy", role: "owner", createdAt: 0 },
  { hostId: "whost_jo", osnProfileId: "usr_jo", handle: "jo", role: "helper", createdAt: 2 },
  { hostId: "whost_cy", osnProfileId: "usr_cy", handle: "cy", role: "editor", createdAt: 3 },
];

type Read = "rsvps" | "guests" | "events" | "households" | "hosts";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Answer every read by its path, holding `held` back until the gate opens —
 * or, with `fail`, answering it with a server error once it does.
 */
function serve(held: Read, fail = false): () => void {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const read = async (name: Read, body: unknown) => {
    if (name !== held) return json(body);
    await gate;
    return fail ? new Response("{}", { status: 500 }) : json(body);
  };
  authFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    const path = url.split("?")[0]!;
    if (url.includes("/invite?include=faqs")) return json({});
    if (path.endsWith("/rsvps")) return read("rsvps", RSVPS_300);
    if (path.endsWith("/guests")) return read("guests", GUESTS_300);
    if (path.endsWith("/events")) return read("events", EVENTS_300);
    if (path.endsWith("/households")) return read("households", HOUSEHOLDS_300);
    if (path.endsWith("/hosts")) {
      return read("hosts", { hosts: HOSTS, total: HOSTS.length, peopleLimit: null });
    }
    if (path.endsWith("/invite")) return json({ inviteMessage: null });
    if (path.endsWith("/changes/head")) return json({ revision: "rev_1" });
    if (path.endsWith("/tasks")) return json({ tasks: [] });
    if (path.endsWith("/settings")) {
      return json({ wedding: { weddingDate: null, currency: "AUD", budgetTotalMinor: null } });
    }
    if (path.endsWith("/budget")) {
      return json({ items: [], payments: [], budgetTotalMinor: null, currency: "AUD" });
    }
    if (path.endsWith("/vendors")) return json({ vendors: [] });
    return json({});
  });
  return open;
}

// ── The record ───────────────────────────────────────────────────────────────
const results: Record<string, "pass" | "fail"> = {};
const measured: Record<string, number> = {};

function expectPass(name: string, ok: boolean, detail = "") {
  results[name] = ok ? "pass" : "fail";
  expect(ok, `${name}${detail ? ` — ${detail}` : ""}`).toBe(true);
}

beforeAll(async () => {
  // Every picture is taken at rest: under reduced motion the pulse ends at
  // full opacity after one 0.01ms run.
  await commands.emulateMedia({ reducedMotion: "reduce" });
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
});

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  __resetGuestsCache();
  __resetEventsCache();
  __resetHouseholdsCache();
  delete document.documentElement.dataset.theme;
});

const sorted = (record: Record<string, unknown>) =>
  `${JSON.stringify(
    Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b))),
    null,
    2,
  )}\n`;

afterAll(async () => {
  await commands.emulateMedia({ reducedMotion: "no-preference" });
  await commands.writeFile(".vitest/skeletons/results.json", sorted(results));
  await commands.writeFile(".vitest/skeletons/measurements.json", sorted(measured));
});

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1)));
    step(n);
  });

const rect = (el: Element) => el.getBoundingClientRect();
const panel = (module: Module) => document.getElementById(`subpanel-${module}`)!;
const viewBar = () => document.querySelector<HTMLElement>("[data-view-bar]")!;
const round = (n: number) => Math.round(n * 10) / 10;

/** The blocks `Skeleton` draws, in document order. An outline is not one. */
const blocks = (scope: Element) =>
  [...scope.querySelectorAll('[class*="animate-[pulse"]')].filter(
    (el) => !el.hasAttribute("data-skeleton-outline"),
  );

/** The outline a hollow view draws while it loads. */
const outlineIn = (scope: Element) => scope.querySelector<HTMLElement>("[data-skeleton-outline]");

/** An outline the view bar holds, if any; a view with no bar holds none. */
const barOutline = () =>
  document.querySelector<HTMLElement>("[data-view-bar] [data-skeleton-outline]");

/**
 * The first line of text a reader would see in `root`: the first text with a
 * letter or digit whose box is drawn and more than a sliver (a visually hidden
 * label is clipped to 1px). Inside an outline that is its first bar, since a
 * run's bar is its text's own inline box.
 */
function firstLine(root: Element): DOMRect | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!/[\p{L}\p{N}]/u.test(node.textContent ?? "") || !parent) continue;
    if (!parent.checkVisibility({ visibilityProperty: true })) continue;
    const box = rect(parent);
    if (box.width <= 1 || box.height <= 1) continue;
    range.selectNodeContents(node);
    const line = range.getClientRects()[0];
    if (line && line.width > 0) return line;
  }
  return null;
}

/** A picture of the window, in each theme, named for the view and the moment. */
async function screenshots(name: string) {
  const frame = document.createElement("div");
  frame.style.cssText = "position:fixed;inset:0;pointer-events:none";
  document.body.append(frame);
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.dataset.theme = theme;
    await frames();
    await page.screenshot({
      path: `__screenshots__/skeletons.browser.test.tsx/${name}-${theme}.png`,
      element: frame,
    });
  }
  delete document.documentElement.dataset.theme;
  frame.remove();
}

/** The space between two boxes stacked one over the other. */
const gapBetween = (a: Element, b: Element) => rect(b).top - rect(a).bottom;

async function settle() {
  await document.fonts.ready;
  await frames();
}

/**
 * The refusal every busy region keeps: nothing in it that a reader could
 * reach. A control, a heading, a form or a live region may sit in it only under
 * an outline that is both `inert` and `aria-hidden`, and no control takes focus.
 */
function checkUnreachable(name: string, busy: Element | undefined) {
  const hidden = (el: Element) => {
    const outline = el.closest("[data-skeleton-outline]");
    return (
      outline !== null &&
      busy?.contains(outline) === true &&
      outline.getAttribute("aria-hidden") === "true" &&
      (outline as HTMLElement).inert
    );
  };
  const readable = [
    ...(busy?.querySelectorAll("h1, h2, h3, form, [role=alert], [role=status]") ?? []),
  ];
  expectPass(
    `${name}: the busy region holds no heading, form or live region a reader can reach`,
    readable.every(hidden),
    `${readable.filter((el) => !hidden(el)).length} reachable`,
  );
  const controls = [
    ...(busy?.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], [tabindex]",
    ) ?? []),
  ];
  expectPass(
    `${name}: no control in the busy region is reachable`,
    controls.every((control) => {
      control.focus();
      return hidden(control) && document.activeElement !== control;
    }),
    `${controls.length} controls`,
  );
}

/** An intro's actions arrive with the list. While it loads they keep their
 *  room, but nothing can see, press or reach them. */
const introActions = (scope: Element) => [
  ...scope.querySelectorAll<HTMLElement>("[data-intro-actions] button"),
];

function checkHeldActions(name: string, scope: Element, want: number) {
  const actions = introActions(scope);
  expectPass(
    `${name}: the intro holds its actions while loading`,
    actions.length === want,
    `${actions.length} held`,
  );
  expectPass(
    `${name}: a held action cannot be seen or focused`,
    actions.every((button) => {
      button.focus();
      return (
        !button.checkVisibility({ visibilityProperty: true }) && document.activeElement !== button
      );
    }),
  );
  return actions.length;
}

function checkLanded(name: string, scope: Element, actions: number) {
  expectPass(
    `${name}: no busy region once loaded`,
    document.querySelector('[aria-busy="true"]') === null,
  );
  expectPass(
    `${name}: the intro's actions are drawn once loaded`,
    introActions(scope).length === actions &&
      introActions(scope).every((button) => button.checkVisibility({ visibilityProperty: true })),
  );
}

// ── Hollow views ─────────────────────────────────────────────────────────────

interface Hollow {
  width: 1280 | 390;
  module: Module;
  sub: string;
  held: Read;
  /** How many actions the view's intro holds, unseen, while it loads. */
  actions?: number;
  /** Once loaded: whether the content has arrived. */
  arrived: (scope: Element) => boolean;
  /** A count line the wide layout lends the view bar: drawn hollow there too. */
  barCount?: boolean;
  /**
   * The parts the outline leaves as they are (DESIGN.md §4, Hollow rows): the
   * first match of each, inside the outline and then inside what replaced it,
   * must have the same edges and ground.
   */
  grounds: readonly string[];
}

/** The colours a frame, a hairline or a ground is drawn in. */
const EDGES = ["border-top-color", "border-bottom-color", "background-color"] as const;

/** `EDGES` of the first `selector` in `root`, or null when there is none. */
function edgesOf(root: Element, selector: string): string[] | null {
  const el = root.querySelector(selector);
  if (!el) return null;
  const style = getComputedStyle(el);
  return EDGES.map((property) => style.getPropertyValue(property));
}

const HOLLOW: Record<string, Hollow> = {
  overview: {
    width: 1280,
    module: "overview",
    sub: "",
    held: "rsvps",
    arrived: (scope) => scope.querySelector(".auto-grid") !== null,
    // A card's frame and ground; an agenda row's rule.
    grounds: [".auto-grid > *", "ul.grid > li"],
  },
  households: {
    width: 1280,
    module: "guests",
    sub: "list",
    held: "guests",
    actions: 2,
    arrived: (scope) => scope.querySelector("[role=group][aria-labelledby]") !== null,
    barCount: true,
    // The list's frame, the head strip, a household's bar and its rule.
    grounds: [
      "div:has(> [data-head-strip])",
      "[data-head-strip]",
      "[data-household-bar]",
      "[role=group]",
    ],
  },
  "rsvp table": {
    width: 1280,
    module: "guests",
    sub: "rsvps",
    held: "rsvps",
    arrived: (scope) => scope.querySelector("tbody > tr") !== null,
    // The table's frame, a head cell's ground and rule, a row's cell.
    grounds: ["div:has(> table)", "thead th", "tbody td"],
  },
};
HOLLOW["overview, phone"] = { ...HOLLOW.overview!, width: 390 };
HOLLOW["households, phone"] = {
  ...HOLLOW.households!,
  width: 390,
  barCount: false,
  // No head strip on a phone.
  grounds: ["div:has(> [role=group])", "[data-household-bar]", "[role=group]"],
};
HOLLOW["rsvp list, phone"] = {
  ...HOLLOW["rsvp table"]!,
  width: 390,
  arrived: (scope) => scope.querySelector('ul[aria-label^="Replies"] > li') !== null,
  grounds: ['ul[aria-label^="Replies"]', 'ul[aria-label^="Replies"] > li'],
};

// ── Block views ──────────────────────────────────────────────────────────────

/**
 * Each block view: the read it waits on, and, once loaded, the boxes its
 * placeholders stand for, in the order the placeholders are drawn.
 */
interface View {
  /** The window's width; 1280 when left out. */
  width?: 390;
  module: Module;
  sub: string;
  held: Read;
  /** The loaded boxes, matched one to one with `blocks()`. */
  content: (scope: Element) => Element[];
  /** Pairs of indexes, into both lists, whose gap must match. */
  gaps: [number, number][];
  /**
   * Whether each placeholder must take its item's height and its list's gap.
   * Off on a phone, where these views keep their 1280px placeholders
   * (cire/host/DESIGN.md §4, Skeletons): only the first placeholder's place is
   * checked.
   */
  sized?: boolean;
  /** How many actions the view's intro holds, unseen, while it loads. */
  actions?: number;
}

const VIEWS: Record<string, View> = {
  "event cards": {
    module: "events",
    sub: "list",
    held: "events",
    content: (scope) => [...scope.querySelectorAll("ul.auto-grid > li")].slice(0, 4),
    gaps: [[0, 2]],
    actions: 1,
  },
  "events editor": {
    module: "events",
    sub: "edit",
    held: "events",
    content: (scope) => [...scope.querySelectorAll("ul > li")].slice(0, 3),
    gaps: [[0, 1]],
    actions: 1,
  },
  "guests editor": {
    module: "guests",
    sub: "edit",
    held: "households",
    content: (scope) => [...scope.querySelectorAll("[data-edit-card]")].slice(0, 3),
    gaps: [[0, 1]],
  },
  "co-hosts": {
    module: "settings",
    sub: "hosts",
    held: "hosts",
    content: (scope) => [...scope.querySelectorAll("ul > li")].slice(0, 2),
    gaps: [[0, 1]],
  },
};

// The block views keep their 1280px placeholders on a phone: there only the
// first placeholder's place is checked, which is where a section intro's
// actions, arriving with the list, would push it down.
for (const name of ["event cards", "events editor", "guests editor"]) {
  VIEWS[`${name}, phone`] = { ...VIEWS[name]!, width: 390, sized: false };
}

describe("loading placeholders", () => {
  for (const [name, view] of Object.entries(HOLLOW)) {
    it(`${name}: the outline stands where its content lands, its first bar on the first line`, async () => {
      await page.viewport(view.width, view.width === 390 ? 844 : 800);
      const open = serve(view.held);
      renderOrganiserPage({ module: view.module, sub: view.sub });
      const scope = () => panel(view.module);
      const busyRegions = () => [...scope().querySelectorAll('[aria-busy="true"]')];
      await vi.waitFor(
        () => expect(busyRegions()[0] && outlineIn(busyRegions()[0]!)).toBeTruthy(),
        {
          timeout: 10_000,
        },
      );
      await settle();

      const slug = `${name.replaceAll(/[ ,]+/g, "-")}-${view.width}`;
      await screenshots(`${slug}-loading`);
      const busy = busyRegions();
      const region = busy[0];
      const outline = outlineIn(region!)!;
      const box = rect(outline);
      const bar = firstLine(outline);
      // The columns the outline draws, where the view has a head strip: the
      // loaded list's, Plus-one included, so no column arrives with the rows.
      const heads = [...outline.querySelectorAll("[data-head-strip] th")].length;
      const groundsLoading = view.grounds.map((selector) => edgesOf(outline, selector));
      const barCount = view.barCount ? barOutline() : null;
      const barCountLine = barCount ? firstLine(barCount) : null;
      expectPass(
        `${name}: the view bar draws the count line hollow, or has none to draw`,
        view.barCount ? barCountLine !== null : barOutline() === null,
      );

      // While loading, one region says so; it holds the outline and nothing a
      // reader can reach.
      expectPass(`${name}: one busy region while loading`, busy.length === 1);
      expectPass(`${name}: the busy region holds the outline`, region?.contains(outline) === true);
      expectPass(
        `${name}: the outline is inert and hidden from a screen reader`,
        outline.inert && outline.getAttribute("aria-hidden") === "true",
      );
      expectPass(`${name}: the outline draws a bar`, bar !== null);
      checkUnreachable(name, region);
      const actions = checkHeldActions(name, scope(), view.actions ?? 0);

      open();
      await vi.waitFor(() => expect(outlineIn(scope())).toBeNull(), { timeout: 10_000 });
      await vi.waitFor(() => expect(view.arrived(scope())).toBe(true), { timeout: 10_000 });
      await settle();
      await screenshots(`${slug}-loaded`);
      checkLanded(name, scope(), actions);
      expectPass(`${name}: no outline is left in the view bar`, barOutline() === null);
      if (barCountLine) {
        const count = [...viewBar()!.querySelectorAll("p")].find((p) =>
          /guests? across/.test(p.textContent ?? ""),
        );
        const countLine = count ? firstLine(count) : null;
        measured[`${name} bar count bar top`] = round(barCountLine.top);
        measured[`${name} bar count line top`] = round(countLine?.top ?? Number.NaN);
        expectPass(
          `${name}: the view bar's count bar stands on the count line`,
          countLine !== null && Math.abs(barCountLine.top - countLine.top) <= 2,
          `${barCountLine.top} against ${countLine?.top}`,
        );
      }

      view.grounds.forEach((selector, i) => {
        const before = groundsLoading[i];
        const after = region ? edgesOf(region, selector) : null;
        expectPass(
          `${name}: the outline keeps ${selector}'s edges and ground`,
          before !== null && after !== null && before.join() === after.join(),
          `${before?.join(" / ")} against ${after?.join(" / ")}`,
        );
      });
      expectPass(
        `${name}: the outline draws the loaded list's columns`,
        heads === [...scope().querySelectorAll("[data-head-strip] th")].length,
        `${heads} heads`,
      );
      // What replaced the outline: the region's first child that is laid out.
      const content = [...(region?.children ?? [])].find((el) => rect(el).height > 0);
      const landed = content ? rect(content) : null;
      const line = content ? firstLine(content) : null;
      measured[`${name} outline top`] = round(box.top);
      measured[`${name} outline left`] = round(box.left);
      measured[`${name} outline width`] = round(box.width);
      measured[`${name} content top`] = round(landed?.top ?? Number.NaN);
      measured[`${name} first bar top`] = round(bar?.top ?? Number.NaN);
      measured[`${name} first bar left`] = round(bar?.left ?? Number.NaN);
      measured[`${name} first line top`] = round(line?.top ?? Number.NaN);
      measured[`${name} first line left`] = round(line?.left ?? Number.NaN);
      expectPass(
        `${name}: the outline stands where its content lands`,
        landed !== null &&
          Math.abs(box.top - landed.top) <= 2 &&
          Math.abs(box.left - landed.left) <= 2 &&
          Math.abs(box.width - landed.width) <= 2,
        `${box.top},${box.left},${box.width} against ${landed?.top},${landed?.left},${landed?.width}`,
      );
      expectPass(
        `${name}: the first bar stands on the content's first line`,
        bar !== null &&
          line !== null &&
          Math.abs(bar.top - line.top) <= 2 &&
          Math.abs(bar.left - line.left) <= 2,
        `${bar?.top},${bar?.left} against ${line?.top},${line?.left}`,
      );
    });
  }

  for (const [name, view] of Object.entries(VIEWS)) {
    it(`${name}: each placeholder is the size of what it stands for`, async () => {
      await page.viewport(view.width ?? 1280, view.width === 390 ? 844 : 800);
      const open = serve(view.held);
      renderOrganiserPage({ module: view.module, sub: view.sub });
      const scope = () => panel(view.module);
      await vi.waitFor(() => expect(blocks(scope()).length).toBeGreaterThan(0), {
        timeout: 10_000,
      });
      await settle();

      const slug = `${name.replaceAll(/[ ,]+/g, "-")}-${view.width ?? 1280}`;
      await screenshots(`${slug}-loading`);
      const held = blocks(scope());
      const heights = held.map((el) => rect(el).height);
      const top = rect(held[0]!).top;
      const gaps = view.gaps.map(([a, b]) => gapBetween(held[a]!, held[b]!));

      // While loading, one region says so, and it holds every placeholder and
      // nothing a reader can reach.
      const busy = [...scope().querySelectorAll('[aria-busy="true"]')];
      expectPass(`${name}: one busy region while loading`, busy.length === 1);
      expectPass(
        `${name}: the busy region holds every placeholder`,
        held.every((el) => busy[0]?.contains(el)),
      );
      checkUnreachable(name, busy[0]);
      const actions = checkHeldActions(name, scope(), view.actions ?? 0);

      open();
      await vi.waitFor(() => expect(blocks(scope())).toEqual([]), { timeout: 10_000 });
      await vi.waitFor(() => expect(view.content(scope()).length).toBe(held.length), {
        timeout: 10_000,
      });
      await settle();

      const content = view.content(scope());
      await screenshots(`${slug}-loaded`);
      checkLanded(name, scope(), actions);
      const lands = rect(content[0]!).top;
      measured[`${name} top content`] = round(lands);
      measured[`${name} top placeholder`] = round(top);
      expectPass(
        `${name}: the first placeholder stands where its content lands`,
        Math.abs(top - lands) <= 2,
        `${top} against ${lands}`,
      );
      // Each item's own height is recorded at every width, sized or not.
      content.forEach((item, i) => {
        measured[`${name} ${i} content`] = round(rect(item).height);
        measured[`${name} ${i} placeholder`] = heights[i]!;
      });
      if (view.sized === false) return;
      content.forEach((_, i) => {
        const want = rect(content[0]!).height;
        expectPass(
          `${name}: placeholder ${i} is the height of the item it stands for`,
          Math.abs(heights[i]! - want) <= 2,
          `${heights[i]} against ${want}`,
        );
      });
      view.gaps.forEach(([a, b], i) => {
        const want = gapBetween(content[a]!, content[b]!);
        measured[`${name} gap ${a}-${b} content`] = round(want);
        measured[`${name} gap ${a}-${b} placeholder`] = gaps[i]!;
        expectPass(
          `${name}: placeholders ${a} and ${b} are spaced as their content`,
          Math.abs(gaps[i]! - want) <= 1.5,
          `${gaps[i]} against ${want}`,
        );
      });
    });
  }

  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    it(`holds the view bar's height and its divider while the replies load, ${width}`, async () => {
      await page.viewport(width, height);
      const open = serve("rsvps");
      renderOrganiserPage({ module: "guests", sub: "rsvps" });
      await vi.waitFor(() => expect(blocks(viewBar()).length).toBeGreaterThan(0), {
        timeout: 10_000,
      });
      await settle();
      await screenshots(`rsvp-bar-${width}-loading`);
      const barWhileLoading = rect(viewBar()).height;
      const divider = viewBar().querySelector("[data-bar-divider]");
      const dividerLeft = divider ? rect(divider).left : Number.NaN;

      open();
      await vi.waitFor(() => expect(blocks(viewBar())).toEqual([]), { timeout: 10_000 });
      await vi.waitFor(() => expect(viewBar().querySelectorAll("[role=tablist]").length).toBe(2), {
        timeout: 10_000,
      });
      await settle();
      const loadedDividers = viewBar().querySelectorAll("[data-bar-divider]");
      expectPass(`bar ${width}: a divider stands before the placeholder`, divider !== null);
      expectPass(
        `bar ${width}: the divider stands where the loaded one does`,
        loadedDividers.length === 1 && Math.abs(rect(loadedDividers[0]!).left - dividerLeft) <= 0.5,
      );
      expectPass(
        `bar ${width}: the bar keeps its height when the replies land`,
        Math.abs(rect(viewBar()).height - barWhileLoading) <= 0.5,
        `${barWhileLoading} then ${rect(viewBar()).height}`,
      );
    });
  }

  it("takes no room when a failed read leaves the busy region empty", async () => {
    await page.viewport(1280, 800);
    const open = serve("events", true);
    renderOrganiserPage({ module: "events", sub: "edit" });
    await vi.waitFor(() => expect(blocks(panel("events")).length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    const region = panel("events").querySelector('[aria-busy="true"]')!;
    open();
    await vi.waitFor(() => expect(panel("events").querySelector('[role="alert"]')).toBeTruthy(), {
      timeout: 10_000,
    });
    await settle();
    // Solid leaves empty text nodes behind; `:empty` passes over them.
    expectPass(
      "failed read: the busy region holds nothing",
      region.children.length === 0 && region.textContent === "",
    );
    expectPass(
      "failed read: the empty region is not laid out",
      getComputedStyle(region).display === "none",
    );
  });
});

describe("the loaders' pulse", () => {
  afterEach(() => commands.emulateMedia({ reducedMotion: "no-preference" }));

  /** A computed duration in milliseconds; Chromium writes 0.01ms as `1e-05s`. */
  const ms = (duration: string) =>
    duration.endsWith("ms") ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1000;

  /**
   * The pulse as the portal's own stylesheet times it, for a `Skeleton` block,
   * a `Loading` line and an outline's bar: its name, its duration in
   * milliseconds and its runs.
   */
  function pulses(): string {
    render(() => (
      <div>
        <Skeleton class="h-7 w-40" />
        <Loading label="Loading guests" />
        <SkeletonOutline>
          <p>Ceremony</p>
        </SkeletonOutline>
      </div>
    ));
    const block = blocks(document.body)[0]!;
    const bar = document.querySelector("[data-skeleton-run]")!;
    const timings = [block, screen.getByRole("status"), bar].map((el) => {
      const style = getComputedStyle(el);
      return [style.animationName, ms(style.animationDuration), style.animationIterationCount];
    });
    cleanup();
    return JSON.stringify(timings);
  }

  it("runs without end for 2s at the desk, and stops after one 0.01ms run under reduced motion", async () => {
    await commands.emulateMedia({ reducedMotion: "no-preference" });
    const desk = pulses();
    expectPass(
      "pulse: a block, a line and a bar run for 2s without end",
      desk ===
        JSON.stringify([
          ["pulse", 2000, "infinite"],
          ["pulse", 2000, "infinite"],
          ["pulse", 2000, "infinite"],
        ]),
      desk,
    );

    await commands.emulateMedia({ reducedMotion: "reduce" });
    const reduced = pulses();
    expectPass(
      "pulse: under reduced motion a block, a line and a bar stop after one 0.01ms run",
      reduced ===
        JSON.stringify([
          ["pulse", 0.01, "1"],
          ["pulse", 0.01, "1"],
          ["pulse", 0.01, "1"],
        ]),
      reduced,
    );
  });
});
