import type { DietaryPreset } from "@cire/dietary";
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
 * - that every heading, badge, button and word still fits its column at desktop,
 *   tablet and phone width, for an editor (five columns) and a viewer (four) —
 *   a column no longer grows to fit a long name, so the name has to break;
 * - that a phone scrolls the region sideways rather than crushing the columns.
 *
 * The measurement that justified the change is at the bottom, opt-in.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import RsvpView from "../../src/components/RsvpView";
import type { RsvpFilterGuest, RsvpFilterInvitedGuest } from "../../src/lib/rsvp-filter";

// ── A wedding-sized guest list ───────────────────────────────────────────────
// Three events, the same 300 guests invited to each: 900 rows. Deterministic,
// so a run can be repeated. The mix is what a real list carries: short and long
// names, a name with no break in it, households of one to four, free-text
// dietary notes up to a sentence, preset-only replies, host-entered replies,
// and a third of the list still to answer.

const FIRST = [
  "Ada",
  "Aiko",
  "Amara",
  "Arjun",
  "Beatrix",
  "Bo",
  "Chiamaka",
  "Cleo",
  "Dev",
  "Dmitri",
  "Elif",
  "Emeka",
  "Farah",
  "Finn",
  "Grace",
  "Hamish",
  "Ines",
  "Isla",
  "Jomo",
  "Kai",
  "Leila",
  "Luca",
  "Mei",
  "Mateo",
  "Nadia",
  "Niamh",
  "Oscar",
  "Priya",
  "Quentin",
  "Rosa",
  "Saoirse",
  "Tariq",
  "Uma",
  "Viktor",
  "Wen",
  "Xavier",
  "Yusuf",
  "Zara",
  "Maximilian-Alexander",
  "Anastasia",
];
const LAST = [
  "Sharma",
  "Jones",
  "Rao",
  "Okonkwo",
  "Nguyen",
  "Fitzgerald-Montgomery",
  "Shapiro",
  "Shaw",
  "Sheridan",
  "Schultz",
  "Smith",
  "Ó Súilleabháin",
  "Papadopoulos",
  "Kowalczyk",
  "Van der Berg",
  "Takahashi",
  "Mbeki",
  "Hernández",
  "Lindqvist",
  "Abernathy",
  "Chen",
  "Rossi",
  "Dubois",
  "Haddad",
  "Ivanova",
  "MacLeod",
  "Oyelaran",
  "Park",
  "Silva",
  "Wojciechowski",
  "Wolfeschlegelsteinhausenbergerdorff",
];
const NOTES = [
  "",
  "",
  "",
  "Coeliac — no cross-contamination please",
  "Severe tree nut allergy, carries an EpiPen. Please flag to the caterer before the day.",
  "Low FODMAP",
  "Can eat fish but not shellfish; no raw egg in desserts either",
  "Toddler — high chair and plain pasta",
];
const PRESET_SETS: DietaryPreset[][] = [
  [],
  [],
  ["vegetarian"],
  ["vegan", "gluten"],
  ["halal", "no_alcohol"],
  ["nuts", "sesame", "other"],
  ["pescatarian", "dairy"],
];
const STATUSES = ["attending", "attending", "declined", "maybe"] as const;

function guestList(count: number): RsvpFilterInvitedGuest[] {
  const guests: RsvpFilterInvitedGuest[] = [];
  let household = 0;
  while (guests.length < count) {
    const size = (household % 4) + 1;
    const last = LAST[household % LAST.length]!;
    const familyName =
      household % 9 === 0 ? `${last} & ${LAST[(household + 7) % LAST.length]}` : last;
    for (let i = 0; i < size && guests.length < count; i += 1) {
      const n = guests.length;
      guests.push({
        guestId: `g${n}`,
        firstName: FIRST[(n * 7) % FIRST.length]!,
        lastName: last,
        familyName,
        familyCode: `${last.slice(0, 4).toUpperCase()}-${String(household).padStart(3, "0")}`,
      });
    }
    household += 1;
  }
  return guests;
}

function eventPayload(id: string, name: string, guests: RsvpFilterInvitedGuest[], seed: number) {
  const replied: RsvpFilterGuest[] = [];
  const silent: RsvpFilterInvitedGuest[] = [];
  for (const [i, guest] of guests.entries()) {
    const k = i + seed;
    if (k % 3 === 0) {
      silent.push(guest);
      continue;
    }
    const presets = PRESET_SETS[k % PRESET_SETS.length]!;
    replied.push({
      ...guest,
      status: STATUSES[k % STATUSES.length]!,
      dietary: presets.includes("other") || k % 5 === 0 ? NOTES[k % NOTES.length]! : "",
      dietaryPresets: presets,
      consentSource: k % 10 === 0 ? "organiser_attested" : "guest",
    });
  }
  const count = (s: string) => replied.filter((g) => g.status === s).length;
  return {
    id,
    name,
    invited: guests.length,
    attending: count("attending"),
    declined: count("declined"),
    maybe: count("maybe"),
    responded: replied.length,
    noResponse: silent.length,
    guests: replied,
    unresponded: silent,
  };
}

const GUESTS = guestList(300);
const PAYLOAD = {
  events: [
    eventPayload("evt_ceremony", "Ceremony", GUESTS, 0),
    eventPayload("evt_reception", "Reception", GUESTS, 1),
    eventPayload("evt_brunch", "Farewell brunch", GUESTS, 2),
  ],
};
const ROWS = PAYLOAD.events.reduce((n, e) => n + e.guests.length + e.unresponded.length, 0);

async function renderList(canEdit = true) {
  authFetch.mockResolvedValue(
    new Response(JSON.stringify(PAYLOAD), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const view = render(() => <RsvpView weddingId="wed_1" canEdit={canEdit} />);
  await vi.waitFor(() => expect(document.querySelectorAll("tbody > tr")).toHaveLength(ROWS), {
    timeout: 5_000,
  });
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
  }
  for (const td of table.querySelectorAll<HTMLTableCellElement>("tbody td")) {
    if (td.scrollWidth > td.clientWidth) out.push(`cell "${td.textContent?.trim()}"`);
    for (const piece of td.querySelectorAll("span.inline-block, button")) {
      if (!inside(piece, td)) out.push(`"${piece.textContent?.trim()}" in its cell`);
    }
  }
  return out;
}

describe("the replies table's layout", () => {
  it("is laid out fixed, from its own column widths rather than its rows", async () => {
    await page.viewport(1280, 900);
    await renderList();
    expect(tables()).toHaveLength(3);
    for (const table of tables()) expect(getComputedStyle(table).tableLayout).toBe("fixed");
  });

  it("keeps every column where it was while a search narrows the list", async () => {
    await page.viewport(1280, 900);
    await renderList();
    const ceremony = tables()[0]!;
    const before = columnShares(ceremony);
    // Leaves only short names and no dietary notes in this event — under auto
    // layout the Dietary column gives its width back and every column moves.
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
      [414, 896],
    ] as const) {
      it(`fits every head, badge, button and word inside its column for ${who} at ${width}px`, async () => {
        await page.viewport(width, height);
        await renderList(canEdit);
        for (const table of tables()) expect(spills(table)).toEqual([]);
      });
    }

    it(`scrolls sideways on a phone for ${who} rather than squeezing the columns`, async () => {
      await page.viewport(414, 896);
      await renderList(canEdit);
      const table = tables()[0]!;
      const region = table.parentElement!;
      expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
      // The floor the column widths add up to: 45rem with the actions column,
      // 37rem without it.
      expect(table.getBoundingClientRect().width).toBe(canEdit ? 720 : 592);
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
// element an inline style never reached. The figures are for this component
// alone, on Solid's development build — a ratio between the arms, not what a
// keystroke costs in the portal.

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

type Arm = "auto" | "fixed";

function useArm(arm: Arm) {
  let style = document.querySelector<HTMLStyleElement>("style[data-layout-arm]");
  if (!style) {
    style = document.createElement("style");
    style.dataset.layoutArm = "";
    document.head.append(style);
  }
  style.textContent = `table { table-layout: ${arm} !important; }`;
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
  it("times the forced layout after each search step, fixed against auto", async ({ annotate }) => {
    await page.viewport(1280, 900);
    await renderList();
    const empty = (): Samples => ({
      narrowing: [],
      widening: [],
      narrowingStep: [],
      rowsLeft: [],
    });
    const samples: Record<Arm, Samples> = { auto: empty(), fixed: empty() };
    // Warm-up, then alternate which arm goes first so neither always runs cold.
    useArm("auto");
    pass(empty());
    for (let round = 0; round < 8; round += 1) {
      const order: Arm[] = round % 2 ? ["fixed", "auto"] : ["auto", "fixed"];
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
    await annotate(`${ROWS} rows, medians. ${summary("auto")}; ${summary("fixed")}`);
    // The numbers mean something only if every timed step really removed rows,
    // and the two arms walked the same list.
    for (const arm of ["auto", "fixed"] as const) {
      expect(samples[arm].rowsLeft.every((left) => left < ROWS)).toBe(true);
    }
    expect(samples.fixed.rowsLeft).toEqual(samples.auto.rowsLeft);
  });
});
