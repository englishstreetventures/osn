import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The RSVP tables are laid out `table-layout: fixed` so that a search, which
 * only ever removes rows, does not make the browser measure every remaining cell
 * to size the columns again. What that trades away is content-sized columns, and
 * only a real engine can say whether the trade holds:
 *
 * - that the layout really is fixed — `Table`'s `class` lands on its scrolling
 *   `<section>`, so the rule reaches the `<table>` through `[&>table]`, and a
 *   descendant selector that stops matching fails silently;
 * - that the columns stay put while a search narrows the list;
 * - that every heading, badge, button and word still fits its column at desktop
 *   and tablet width, for an editor (five columns) and a viewer (four) — a
 *   column no longer grows to fit a long name, so the name has to break;
 * - that the narrow layout a phone gets — stacked rows, no table — keeps every
 *   word, badge and button inside its block, and never scrolls sideways.
 *
 * The view is drawn alone, so which layout it draws is its `compact` prop: the
 * module shell decides it from the panel's width.
 *
 * The measurement that justified the change is at the bottom, opt-in.
 *
 * One event is drawn at a time, so these measure the event on screen: the
 * first, a 900-row list. The sticky head and Guest column are measured in
 * `RsvpView.events.browser.test.tsx`.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
// The change feed is not what this suite measures; stub its two calls so the
// only request is the RSVP read.
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => null,
  markRsvpChangesSeen: async () => {},
}));

import RsvpView from "../../src/components/RsvpView";
import { eventPayload, guestList } from "../test-support/rsvp-guests";

// Three events. The first, the one on screen, is a 900-guest list; the other
// two, 300 guests each, sit behind their tabs and are never drawn here. The
// generator (`test-support/rsvp-guests.ts`) gives the mix a real list carries:
// short and long names, a name with no break in it, households of one to
// four, free-text dietary notes up to a sentence, preset-only replies,
// host-entered replies, plus-ones marked with their inviter's full name (the
// longest names included) and badged Household-entered, and a third of the
// list still to answer.
const PAYLOAD = {
  events: [
    eventPayload("evt_ceremony", "Ceremony", guestList(900), 0),
    eventPayload("evt_reception", "Reception", guestList(300), 1),
    eventPayload("evt_brunch", "Farewell brunch", guestList(300), 2),
  ],
};
const FIRST_EVENT = PAYLOAD.events[0]!;
const ROWS = FIRST_EVENT.guests.length + FIRST_EVENT.unresponded.length;

async function renderList(canEdit = true, compact = false) {
  authFetch.mockResolvedValue(
    new Response(JSON.stringify(PAYLOAD), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const view = render(() => <RsvpView weddingId="wed_1" canEdit={canEdit} compact={compact} />);
  await vi.waitFor(
    () =>
      expect(document.querySelectorAll('tbody > tr, ul[aria-label^="Replies"] > li')).toHaveLength(
        ROWS,
      ),
    { timeout: 5_000 },
  );
  await document.fonts.ready;
  return view;
}

const searchBox = () => document.querySelector<HTMLInputElement>('input[type="search"]')!;

/** Type into the search box the way Solid hears it: one bubbling `input`. */
function search(value: string) {
  const box = searchBox();
  box.value = value;
  box.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  document.querySelector("style[data-layout-arm]")?.remove();
});

const tables = () => [...document.querySelectorAll("table")];

/** Each column head's width as a share of its table — immune to the page's own
 *  width moving, so it isolates what the table decided. */
function columnShares(table: HTMLTableElement): number[] {
  const whole = table.getBoundingClientRect().width;
  return [...table.querySelectorAll("thead th")].map(
    (th) => Math.round((th.getBoundingClientRect().width / whole) * 1000) / 1000,
  );
}

/** Whether `inner` sits wholly inside `outer`'s box, to the half pixel. */
function inside(inner: Element, outer: Element): boolean {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
}

/** Every head, badge, button and cell of a table that spills out of its column. */
function spills(table: HTMLTableElement): string[] {
  const out: string[] = [];
  for (const th of table.querySelectorAll("thead th")) {
    if (th.scrollWidth > th.clientWidth) out.push(`head "${th.textContent?.trim()}"`);
    // A sort head's button, label and arrow, inside its column.
    for (const button of th.querySelectorAll("button")) {
      if (!inside(button, th)) out.push(`"${button.textContent?.trim()}" in its head`);
    }
  }
  for (const td of table.querySelectorAll<HTMLTableCellElement>("tbody td")) {
    if (td.scrollWidth > td.clientWidth) out.push(`cell "${td.textContent?.trim()}"`);
    for (const piece of td.querySelectorAll("[data-provenance], [data-status], button")) {
      if (!inside(piece, td)) out.push(`"${piece.textContent?.trim()}" in its cell`);
    }
  }
  return out;
}

describe("the replies table's layout", () => {
  it("carries plus-ones with the longest inviter names, so the checks below see them", async () => {
    await page.viewport(1280, 900);
    await renderList();
    const markers = [...document.querySelectorAll("tbody td span")]
      .map((span) => span.textContent?.trim() ?? "")
      .filter((text) => text.startsWith("Plus-one of"));
    expect(markers.length).toBeGreaterThan(30);
    expect(markers.some((text) => text.includes("Wolfeschlegelsteinhausenbergerdorff"))).toBe(true);
    expect(
      [...document.querySelectorAll("tbody [data-provenance]")].some(
        // The icon's name: the badge also holds its hidden explanation.
        (badge) => badge.textContent?.trim() === "Household-entered",
      ),
    ).toBe(true);
  });

  it("is laid out fixed, from its own column widths rather than its rows", async () => {
    await page.viewport(1280, 900);
    await renderList();
    // One event is drawn at a time.
    expect(tables()).toHaveLength(1);
    for (const table of tables()) expect(getComputedStyle(table).tableLayout).toBe("fixed");
  });

  it("keeps every column where it was while a search narrows the list", async () => {
    await page.viewport(1280, 900);
    await renderList();
    const ceremony = tables()[0]!;
    const before = columnShares(ceremony);
    // Leaves 34 of the 900 rows — under auto layout the columns would be
    // sized again from what is left, and every one of them would move.
    search("rao");
    expect(ceremony.isConnected).toBe(true);
    expect(ceremony.querySelectorAll("tbody > tr").length).toBeLessThan(40);
    expect(columnShares(ceremony)).toEqual(before);
  });

  for (const canEdit of [true, false]) {
    const who = canEdit ? "an editor" : "a viewer";
    for (const [width, height] of [
      [1280, 900],
      [768, 1024],
    ] as const) {
      it(`fits every head, badge, button and word inside its column for ${who} at ${width}px`, async () => {
        await page.viewport(width, height);
        await renderList(canEdit);
        for (const table of tables()) expect(spills(table)).toEqual([]);
      });
    }

    it(`fits every word, badge and button inside its block on a phone for ${who}`, async () => {
      await page.viewport(414, 896);
      await renderList(canEdit, true);
      expect(tables()).toHaveLength(0);
      const out: string[] = [];
      for (const block of document.querySelectorAll<HTMLElement>(
        'ul[aria-label^="Replies"] > li',
      )) {
        if (block.scrollWidth > block.clientWidth) out.push(`block "${block.textContent?.trim()}"`);
        for (const piece of block.querySelectorAll("p, span.inline-block, button")) {
          if (!inside(piece, block)) out.push(`"${piece.textContent?.trim()}" in its block`);
        }
      }
      expect(out).toEqual([]);
    });

    it(`does not scroll sideways on a phone for ${who}`, async () => {
      await page.viewport(414, 896);
      await renderList(canEdit, true);
      const list = document.querySelector<HTMLElement>('ul[aria-label^="Replies"]')!;
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
      // The block keeps everything a row held: the button that records a
      // reply is there for an editor, and for a viewer it is not.
      expect(list.querySelectorAll("li button[aria-label*=' reply for ']").length).toBe(
        canEdit ? ROWS : 0,
      );
    });
  }
});

// ── The measurement ──────────────────────────────────────────────────────────
// Opt-in, and the verbose reporter is what prints the result:
//
//   VITE_RSVP_LAYOUT_BENCH=1 bun run --cwd cire/host test:browser \
//     --reporter=verbose tests/components/RsvpView.layout.browser.test.tsx
//
// It times layout, which varies by machine, so it asserts nothing about the
// numbers and stays out of CI; what CI keeps is the deterministic half above.
// Each arm is a stylesheet rule rather than an inline style, because a search
// that empties an event unmounts its table and the next one mounts a fresh
// element an inline style never reached. Three arms: auto layout, fixed layout
// as shipped, and fixed layout with the sticky head and Guest column turned
// off — the last pair is what the sticky cells cost. The figures are for this
// component alone, on Solid's development build — a ratio between the arms,
// not what a keystroke costs in the portal.

const NARROWING = [
  ["s", "sh", "sha", "shar"],
  ["n", "ng", "ngu"],
  ["m", "ma", "mac"],
  ["o", "ok", "oko"],
  ["p", "pa", "pap"],
] as const;

function median(xs: number[]): number {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type Arm = "auto" | "fixed" | "unstuck";
const ARMS: readonly Arm[] = ["auto", "fixed", "unstuck"];

function useArm(arm: Arm) {
  let style = document.querySelector<HTMLStyleElement>("style[data-layout-arm]");
  if (!style) {
    style = document.createElement("style");
    style.dataset.layoutArm = "";
    document.head.append(style);
  }
  style.textContent =
    arm === "unstuck"
      ? "table { table-layout: fixed !important; } th, td { position: static !important; }"
      : `table { table-layout: ${arm} !important; }`;
  void document.documentElement.offsetHeight;
}

interface Samples {
  /** Forced layout after a step that only removes rows. */
  narrowing: number[];
  /** Forced layout after clearing the box, which puts every row back. */
  widening: number[];
  /** Whole narrowing steps — Solid's update and the layout together. */
  narrowingStep: number[];
  /** Rows left in the document after each narrowing step. */
  rowsLeft: number[];
}

/**
 * One pass of the typing sequence. Solid applies a search to the DOM before
 * `dispatchEvent` returns, so the time from there to a forced layout is the
 * layout alone; the time from before the dispatch is the whole step.
 */
function pass(into: Samples) {
  const step = (value: string, layout: number[], whole?: number[]) => {
    const start = performance.now();
    search(value);
    const applied = performance.now();
    void document.documentElement.offsetHeight;
    const end = performance.now();
    layout.push(end - applied);
    whole?.push(end - start);
  };
  for (const steps of NARROWING) {
    for (const value of steps) {
      step(value, into.narrowing, into.narrowingStep);
      into.rowsLeft.push(document.querySelectorAll("tbody > tr").length);
    }
    step("", into.widening);
  }
}

describe.runIf(import.meta.env.VITE_RSVP_LAYOUT_BENCH === "1")("RSVP table layout cost", () => {
  it("times the forced layout after each search step, by arm", async ({ annotate }) => {
    await page.viewport(1280, 900);
    await renderList();
    const empty = (): Samples => ({
      narrowing: [],
      widening: [],
      narrowingStep: [],
      rowsLeft: [],
    });
    const samples: Record<Arm, Samples> = { auto: empty(), fixed: empty(), unstuck: empty() };
    // Warm-up, then rotate which arm goes first so none always runs cold.
    useArm("auto");
    pass(empty());
    for (let round = 0; round < 9; round += 1) {
      const order = ARMS.map((_, i) => ARMS[(i + round) % ARMS.length]!);
      for (const arm of order) {
        useArm(arm);
        pass(samples[arm]);
      }
    }
    const ms = (xs: number[]) => `${median(xs).toFixed(2)}ms`;
    const summary = (arm: Arm) =>
      `${arm}: narrowing layout ${ms(samples[arm].narrowing)} of a ` +
      `${ms(samples[arm].narrowingStep)} step (n=${samples[arm].narrowing.length}), ` +
      `widening layout ${ms(samples[arm].widening)} (n=${samples[arm].widening.length})`;
    await annotate(`${ROWS} rows, medians. ${ARMS.map(summary).join("; ")}`);
    // The numbers mean something only if every timed step really removed rows,
    // and every arm walked the same list.
    for (const arm of ARMS) {
      expect(samples[arm].rowsLeft.every((left) => left < ROWS)).toBe(true);
      expect(samples[arm].rowsLeft).toEqual(samples.auto.rowsLeft);
    }
  });
});
