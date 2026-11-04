import { cleanup } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Each view's loading placeholders against the content that replaces them, in
 * the real `ModuleShell` under the real `TopBar` (`test-support/organiser-page.tsx`),
 * at the size a wedding reaches (`guests-300`).
 *
 * A view that loads holds its rows' height with a placeholder the size of each
 * (cire/host/DESIGN.md §4, the owner's answer on #1837). Each view's read is
 * held back by a gate; the placeholders are measured, the gate opens, and the
 * content is measured. What is checked:
 *
 * - at 1280px, each placeholder is the height of the item it stands for (the
 *   first, in a list whose items differ), and
 *   a list of them is spaced as the list it stands for, to 2px; at 390px too
 *   for the two views that draw another layout there (the households and the
 *   RSVP replies);
 * - the view bar is the same height while the RSVP replies load as after, at
 *   1280px and at 390px, and its divider stands where the loaded one does;
 * - `aria-busy` marks the region that holds the placeholders while it loads,
 *   never a form or the view's heading, and is gone once the content lands.
 *
 * Artifacts: `cire/host/.vitest/skeletons/results.json`, one pass or fail per
 * named check, with no pixel values so a rerun writes the same file; and
 * `measurements.json` beside it, the heights and gaps read on this machine.
 * Both are gitignored.
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

/** Answer every read by its path, holding `held` back until the gate opens. */
function serve(held: Read): () => void {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const read = async (name: Read, body: unknown) => {
    if (name === held) await gate;
    return json(body);
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

beforeAll(() => {
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
});

const sorted = (record: Record<string, unknown>) =>
  `${JSON.stringify(
    Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b))),
    null,
    2,
  )}\n`;

afterAll(async () => {
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

/** The placeholders `Skeleton` draws, in document order. */
const blocks = (scope: Element) => [...scope.querySelectorAll('[class*="animate-[pulse"]')];

/** The space between two boxes stacked one over the other. */
const gapBetween = (a: Element, b: Element) => rect(b).top - rect(a).bottom;

async function settle() {
  await document.fonts.ready;
  await frames();
}

/**
 * Each view: the read it waits on, and, once loaded, the boxes its
 * placeholders stand for, in the order the placeholders are drawn. A pair
 * whose second box is `null` is a single block, with no gap to compare.
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
   * How many one-off blocks lead the list (a band, a head row), each sized to
   * its own box. Every placeholder after them stands for one item of a list
   * whose items differ, and takes the first item's height.
   */
  heads?: number;
}

const VIEWS: Record<string, View> = {
  overview: {
    module: "overview",
    sub: "",
    held: "rsvps",
    content: (scope) => {
      const grid = scope.querySelector(".auto-grid")!;
      return [grid.previousElementSibling!, ...[...grid.children].slice(0, 3)];
    },
    gaps: [[0, 1]],
    heads: 1,
  },
  "event cards": {
    module: "events",
    sub: "list",
    held: "events",
    content: (scope) => [...scope.querySelectorAll("ul.auto-grid > li")].slice(0, 4),
    gaps: [[0, 2]],
  },
  "events editor": {
    module: "events",
    sub: "edit",
    held: "events",
    content: (scope) => [...scope.querySelectorAll("ul > li")].slice(0, 3),
    gaps: [[0, 1]],
  },
  households: {
    module: "guests",
    sub: "list",
    held: "guests",
    content: (scope) => [
      scope.querySelector("[data-head-strip]")!,
      ...[...scope.querySelectorAll("[role=group][aria-labelledby]")].slice(0, 4),
    ],
    gaps: [
      [0, 1],
      [1, 2],
    ],
    heads: 1,
  },
  "guests editor": {
    module: "guests",
    sub: "edit",
    held: "households",
    content: (scope) => [...scope.querySelectorAll("[data-edit-card]")].slice(0, 3),
    gaps: [[0, 1]],
  },
  "rsvp table": {
    module: "guests",
    sub: "rsvps",
    held: "rsvps",
    content: (scope) => [
      scope.querySelector("thead")!,
      ...[...scope.querySelectorAll("tbody > tr")].slice(0, 3),
    ],
    gaps: [
      [0, 1],
      [1, 2],
    ],
    heads: 1,
  },
  "households, phone": {
    width: 390,
    module: "guests",
    sub: "list",
    held: "guests",
    content: (scope) => [...scope.querySelectorAll("[role=group][aria-labelledby]")].slice(0, 4),
    gaps: [[0, 1]],
  },
  "rsvp list, phone": {
    width: 390,
    module: "guests",
    sub: "rsvps",
    held: "rsvps",
    content: (scope) => [...scope.querySelectorAll('ul[aria-label^="Replies"] > li')].slice(0, 3),
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

describe("loading placeholders", () => {
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

      const held = blocks(scope());
      const heights = held.map((el) => rect(el).height);
      const gaps = view.gaps.map(([a, b]) => gapBetween(held[a]!, held[b]!));

      // While loading, one region says so, and it holds every placeholder and
      // neither the view's heading nor a form a host can still use.
      const busy = [...scope().querySelectorAll('[aria-busy="true"]')];
      expectPass(`${name}: one busy region while loading`, busy.length === 1);
      expectPass(
        `${name}: the busy region holds every placeholder`,
        held.every((el) => busy[0]?.contains(el)),
      );
      expectPass(
        `${name}: the busy region holds no form or heading`,
        busy[0]?.querySelector("form, h2") === null,
      );

      open();
      await vi.waitFor(() => expect(blocks(scope())).toEqual([]), { timeout: 10_000 });
      await vi.waitFor(() => expect(view.content(scope()).length).toBe(held.length), {
        timeout: 10_000,
      });
      await settle();

      const content = view.content(scope());
      expectPass(
        `${name}: no busy region once loaded`,
        document.querySelector('[aria-busy="true"]') === null,
      );
      const heads = view.heads ?? 0;
      content.forEach((_, i) => {
        const want = rect(content[Math.min(i, heads)]!).height;
        measured[`${name} ${i} content`] = Math.round(want * 10) / 10;
        measured[`${name} ${i} placeholder`] = heights[i]!;
        expectPass(
          `${name}: placeholder ${i} is the height of the item it stands for`,
          Math.abs(heights[i]! - want) <= 2,
          `${heights[i]} against ${want}`,
        );
      });
      view.gaps.forEach(([a, b], i) => {
        const want = gapBetween(content[a]!, content[b]!);
        measured[`${name} gap ${a}-${b} content`] = Math.round(want * 10) / 10;
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
});
