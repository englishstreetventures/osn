import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A budget line's two panels, "per head" and "payments (n)", open through
 * `@cire/ui`'s `Reveal`, measured in Chromium:
 *
 * - opening grows the panel from no height, frame by frame, and the line below
 *   moves down by the same amount on every frame;
 * - closing is done on the next frame, the line below back where it was;
 * - neither panel takes focus as it opens, and "payments (n)" reports itself
 *   open and closed through `aria-expanded`;
 * - a closed panel adds no height to its line, though its wrapper stays in it;
 * - every control in an open panel keeps its whole focus ring inside every box
 *   that clips it, the `Reveal` among them, at a desk and on a phone;
 * - an open line keeps the spacing of the row it replaced: 8px in from its top
 *   and bottom, 12px from its sides, 8px between its parts, and a payment's ✕
 *   under the line's ✕;
 * - a long unbroken payment label or event name wraps inside the clip;
 * - with reduced motion asked for, the panel opens at full height at once.
 *
 * happy-dom computes no layout and runs no transitions, so none of this is
 * visible to the unit tier. `--motion-scale` is raised so a run spans enough
 * frames to sample. Screenshots go to `e2e-artifacts/cire-host/budget-reveal/`.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import BudgetView from "../../src/components/BudgetView";
import { __resetBudgetCache, setCachedBudget } from "../../src/lib/budget-store";

const SHOTS = "../../../../e2e-artifacts/cire-host/budget-reveal";
const MOTION_SCALE = 4;

const item = (id: string, name: string, sortOrder: number) => ({
  id,
  weddingId: "wed_1",
  category: "venue",
  name,
  estimateMinor: 1_200_000,
  quotedMinor: null,
  actualMinor: null,
  notes: null,
  sortOrder,
  createdAt: 1,
  updatedAt: 1,
  unitPriceMinor: null,
  eventIds: null,
  headcount: null,
});

const SNAPSHOT = {
  items: [item("hall", "Reception venue", 0), item("chapel", "Ceremony venue", 1)],
  payments: [
    {
      id: "pay_1",
      budgetItemId: "hall",
      label: "Deposit",
      amountMinor: 300_000,
      dueAt: "2027-01-15",
      paidAt: null,
      createdAt: 2,
    },
  ],
  budgetTotalMinor: null,
  currency: "AUD",
  events: [
    { id: "evt_ceremony", name: "Ceremony" },
    { id: "evt_reception", name: "Reception" },
  ],
  rsvpsClosed: false,
};

/** A label or event name of the longest a budget takes (80 characters), with
 *  no space in it to break at. */
const LONG_WORD = "Benachrichtigungseinstellungen".repeat(3).slice(0, 80);

/** The first line priced per head, so its line carries the per-head summary and
 *  its panel "Use a fixed amount"; a second payment and an event, each named by
 *  one long word. */
const PER_HEAD = {
  ...SNAPSHOT,
  items: [
    {
      ...item("hall", "Reception venue", 0),
      estimateMinor: null,
      unitPriceMinor: 15_000,
      headcount: { expected: 80, confirmed: 40 },
    },
    item("chapel", "Ceremony venue", 1),
  ],
  payments: [
    ...SNAPSHOT.payments,
    {
      id: "pay_2",
      budgetItemId: "hall",
      label: LONG_WORD,
      amountMinor: 100_000,
      dueAt: null,
      paidAt: null,
      createdAt: 3,
    },
  ],
  events: [...SNAPSHOT.events, { id: "evt_long", name: LONG_WORD }],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const settle = async () => {
  await nextFrame();
  await nextFrame();
};

/** The line `name` heads, and the line after it. */
const line = (name: string) => screen.getByText(name).closest("li")!;

/** A line's `Reveal` wrappers, in order: per head, then payments. */
function reveals(li: HTMLElement): HTMLElement[] {
  return [...li.children].filter(
    (el): el is HTMLElement => getComputedStyle(el).display === "grid",
  );
}

/**
 * The height a panel takes in its line: its `Reveal` wrapper's box plus its
 * margins. The wrapper keeps 4px of room for the focus ring on every side and a
 * matching negative margin hands that room back, so its box alone is 8px taller
 * than the space the line gives it. Not the row inside the wrapper: mid-opening
 * Chrome sizes that row against the wrapper's own height, so it lags the line.
 */
function takenHeight(reveal: HTMLElement): number {
  const s = getComputedStyle(reveal);
  return (
    reveal.getBoundingClientRect().height + parseFloat(s.marginTop) + parseFloat(s.marginBottom)
  );
}

function longestTransitionMs(el: HTMLElement): number {
  return Math.max(
    ...getComputedStyle(el)
      .transitionDuration.split(",")
      .map((d) => parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000)),
  );
}

interface Frame {
  height: number;
  belowMoved: number;
  panelHasFocus: boolean;
}

/** Clicks `toggle` and records, each frame until the transition is over, the
 *  height the panel takes, how far the next line has moved, and where focus is. */
async function sampleOpening(
  toggle: HTMLElement,
  reveal: HTMLElement,
  below: HTMLElement,
): Promise<Frame[]> {
  const belowTop = below.getBoundingClientRect().top;
  const runMs = longestTransitionMs(reveal);
  // Focus first, as a press on a button does; `click()` alone moves no focus.
  toggle.focus();
  toggle.click();
  const start = performance.now();
  const frames: Frame[] = [];
  do {
    await nextFrame();
    frames.push({
      height: takenHeight(reveal),
      belowMoved: below.getBoundingClientRect().top - belowTop,
      panelHasFocus: reveal.contains(document.activeElement),
    });
  } while (performance.now() - start < runMs + 120);
  return frames;
}

async function mount() {
  setCachedBudget("wed_1", SNAPSHOT);
  render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
  await screen.findByText("Ceremony venue");
  // No line is per head, so the cached budget is used as it is: nothing is
  // fetched, and no row is rebuilt while a test samples it.
  await settle();
  expect(authFetch).not.toHaveBeenCalled();
}

/** Mounts {@link PER_HEAD}. A per-head line has the view refetch its figures
 *  on open, so this waits for that answer and the rebuild it brings before
 *  anything is measured. */
async function mountPerHead() {
  authFetch.mockImplementation(() => Promise.resolve(json(PER_HEAD)));
  setCachedBudget("wed_1", PER_HEAD);
  render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
  await screen.findByText("Ceremony venue");
  await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
  await settle();
}

/** Opens both of the first line's panels with reduced motion asked for, so
 *  each lands at full height at once, and returns the line's parts. */
async function openBothPanels() {
  await commands.emulateMedia({ reducedMotion: "reduce" });
  await mountPerHead();
  screen.getAllByRole("button", { name: "per head" })[0]!.click();
  screen.getAllByRole("button", { name: "payments (2)" })[0]!.click();
  await settle();
  const li = line("Reception venue");
  const [perHead, payments] = reveals(li);
  return { li, perHead: perHead!, payments: payments! };
}

const rect = (el: Element) => el.getBoundingClientRect();

/** Every box between `el` and its budget line `li` that clips it, nearest
 *  first: one whose `overflow` is not `visible` on either axis. */
function clipsRound(el: Element, li: Element): Element[] {
  const clips: Element[] = [];
  for (let a = el.parentElement; a && a !== li; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") clips.push(a);
  }
  return clips;
}

/** A box's padding edge, where its clip cuts. */
function paddingEdge(el: Element) {
  const r = rect(el);
  const s = getComputedStyle(el);
  return {
    top: r.top + parseFloat(s.borderTopWidth),
    bottom: r.bottom - parseFloat(s.borderBottomWidth),
    left: r.left + parseFloat(s.borderLeftWidth),
    right: r.right - parseFloat(s.borderRightWidth),
  };
}

/** Where a flex row's own items start and end, not its padding. */
function itemsBox(row: Element): { top: number; bottom: number } {
  const boxes = [...row.children].map(rect);
  return {
    top: Math.min(...boxes.map((b) => b.top)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

beforeEach(async () => {
  await page.viewport(1280, 800);
  authFetch.mockImplementation(() => Promise.resolve(json(SNAPSHOT)));
  document.documentElement.style.setProperty("--motion-scale", String(MOTION_SCALE));
});

afterEach(async () => {
  cleanup();
  authFetch.mockReset();
  __resetBudgetCache();
  document.documentElement.style.removeProperty("--motion-scale");
  await commands.emulateMedia({ colorScheme: "no-preference", reducedMotion: "no-preference" });
});

describe("BudgetView line panels, as they open", () => {
  for (const [label, name, index] of [
    ["payments", "payments (1)", 1],
    ["per head", "per head", 0],
  ] as const) {
    it(`grows the ${label} panel from nothing and moves the next line with it`, async () => {
      await mount();
      const hall = line("Reception venue");
      const below = line("Ceremony venue");
      const reveal = reveals(hall)[index]!;
      const toggle = screen.getAllByRole("button", { name })[0]!;
      expect(takenHeight(reveal)).toBe(0);

      const frames = await sampleOpening(toggle, reveal, below);
      const full = frames.at(-1)!.height;
      const heights = frames.map((f) => f.height.toFixed(1)).join(", ");

      expect(full, "open panel height").toBeGreaterThan(40);
      expect(frames[0]!.height, `first frame of ${heights}`).toBeLessThan(full / 2);
      const between = frames.filter((f) => f.height > 0.5 && f.height < full - 0.5);
      expect(between.length, `frames between closed and open: ${heights}`).toBeGreaterThanOrEqual(
        5,
      );
      frames.slice(1).forEach((f, i) => {
        expect(f.height, `frame ${i + 1} of ${heights}`).toBeGreaterThanOrEqual(
          frames[i]!.height - 0.01,
        );
      });
      for (const [i, f] of frames.entries()) {
        expect(f.belowMoved, `next line on frame ${i}`).toBeCloseTo(f.height, 0);
        expect(f.panelHasFocus, `focus inside the panel on frame ${i}`).toBe(false);
      }
      expect(document.activeElement).toBe(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });
  }

  it("closes on the next frame and puts the next line back", async () => {
    await mount();
    const hall = line("Reception venue");
    const below = line("Ceremony venue");
    const belowTop = below.getBoundingClientRect().top;
    const [perHead, payments] = reveals(hall);
    for (const [toggle, reveal] of [
      [screen.getAllByRole("button", { name: "payments (1)" })[0]!, payments!],
      [screen.getAllByRole("button", { name: "per head" })[0]!, perHead!],
    ] as const) {
      await sampleOpening(toggle, reveal, below);
      expect(takenHeight(reveal)).toBeGreaterThan(40);
      toggle.click();
      await nextFrame();
      expect(takenHeight(reveal)).toBe(0);
      expect(below.getBoundingClientRect().top).toBeCloseTo(belowTop, 1);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("adds no height to a line while both panels are closed", async () => {
    await mount();
    for (const name of ["Reception venue", "Ceremony venue"]) {
      const li = line(name);
      const style = getComputedStyle(li);
      const frame =
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth);
      const head = (li.firstElementChild as HTMLElement).getBoundingClientRect().height;
      expect(reveals(li)).toHaveLength(2);
      expect(li.getBoundingClientRect().height, `${name}: line height`).toBeCloseTo(
        head + frame,
        1,
      );
    }
  });

  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    // A per-head line with "Only these events" chosen, so the panel holds
    // every control it can draw: the event boxes and "Use a fixed amount" too.
    // At 390px the forms wrap, which changes which control meets an edge.
    it(`keeps every control's focus ring inside the panel's clip at ${width}px`, async () => {
      await page.viewport(width, height);
      const root = getComputedStyle(document.documentElement);
      const ring =
        parseFloat(root.getPropertyValue("--focus-ring-width")) +
        parseFloat(root.getPropertyValue("--focus-ring-offset"));
      expect(ring).toBe(4);
      const panels = await openBothPanels();
      screen.getByLabelText("Only these events").click();
      await settle();
      expect(screen.getByRole("checkbox", { name: "Reception" }).checkVisibility()).toBe(true);
      expect(screen.getByRole("button", { name: "Use a fixed amount" }).checkVisibility()).toBe(
        true,
      );
      for (const [name, reveal] of [
        ["per head", panels.perHead],
        ["payments", panels.payments],
      ] as const) {
        const controls = [
          ...reveal.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]"),
        ].filter((el) => el.getClientRects().length > 0);
        expect(controls.length, `${name}: controls`).toBeGreaterThan(2);
        for (const el of controls) {
          const box = rect(el);
          const what = `${name}: ${el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName}`;
          const clips = clipsRound(el, panels.li);
          expect(clips, `${what}: clipped by its panel`).toContain(reveal);
          for (const clip of clips.map(paddingEdge)) {
            expect(box.top - ring, `${what} top`).toBeGreaterThanOrEqual(clip.top - 0.5);
            expect(box.bottom + ring, `${what} bottom`).toBeLessThanOrEqual(clip.bottom + 0.5);
            expect(box.left - ring, `${what} left`).toBeGreaterThanOrEqual(clip.left - 0.5);
            expect(box.right + ring, `${what} right`).toBeLessThanOrEqual(clip.right + 0.5);
          }
        }
      }
    });

    // DESIGN.md §4: the line reads 8px in from its top and bottom and 12px from
    // its sides, with 8px between its parts, as the `px-3 py-2` row with
    // `gap-2` it replaced did. Each gap is between what the parts draw, not
    // between their padded boxes.
    it(`spaces an open line's parts 8px apart at ${width}px`, async () => {
      await page.viewport(width, height);
      const { li, perHead, payments } = await openBothPanels();
      const style = getComputedStyle(li);
      const inner = {
        top: rect(li).top + parseFloat(style.borderTopWidth),
        bottom: rect(li).bottom - parseFloat(style.borderBottomWidth),
        left: rect(li).left + parseFloat(style.borderLeftWidth),
      };
      const header = itemsBox(li.firstElementChild!);
      const summary = rect(screen.getByTestId("per-head-summary"));
      const perHeadForm = rect(screen.getByTestId("per-head-panel"));
      const paymentList = rect(
        screen.getByLabelText("Payment label").closest("form")!.parentElement!,
      );
      expect(perHead.contains(screen.getByTestId("per-head-panel"))).toBe(true);
      expect(payments.contains(screen.getByLabelText("Payment label"))).toBe(true);

      expect(header.top - inner.top, "line top to header").toBeCloseTo(8, 0);
      expect(summary.top - header.bottom, "header to per-head summary").toBeCloseTo(8, 0);
      expect(perHeadForm.top - summary.bottom, "summary to per-head panel").toBeCloseTo(8, 0);
      expect(paymentList.top - perHeadForm.bottom, "per-head panel to payments").toBeCloseTo(8, 0);
      expect(inner.bottom - paymentList.bottom, "payments to line bottom").toBeCloseTo(8, 0);
      expect(
        rect(li.firstElementChild!.firstElementChild!).left - inner.left,
        "line left to its first control",
      ).toBeCloseTo(12, 0);
    });
  }

  // At a desk the header is one row, so its ✕ ends it: a payment's ✕ sits in
  // the same column, 12px in from the line's right edge.
  it("lines a payment's ✕ up under the line's ✕ at 1280px", async () => {
    const { li } = await openBothPanels();
    const inner = rect(li).right - parseFloat(getComputedStyle(li).borderRightWidth);
    const lineCross = rect(within(li).getByRole("button", { name: "Delete item" }));
    expect(inner - lineCross.right, "line ✕ to the line's right edge").toBeCloseTo(12, 0);
    for (const cross of within(li).getAllByRole("button", { name: "Delete payment" })) {
      expect(Math.abs(rect(cross).right - lineCross.right)).toBeLessThanOrEqual(0.5);
    }
  });

  // A payment label or an event name may be one 80-character word. It wraps
  // inside the panel's content instead of running into the `Reveal`'s ring
  // room and under its clip.
  it("wraps a long unbroken payment label and event name inside the panel at 390px", async () => {
    await page.viewport(390, 844);
    const { perHead, payments } = await openBothPanels();
    screen.getByLabelText("Only these events").click();
    await settle();

    const paymentRow = screen
      .getByRole("checkbox", { name: `${LONG_WORD} paid` })
      .closest("[data-payment]")!;
    const paymentText = [...paymentRow.querySelectorAll<HTMLElement>("span")].find((s) =>
      s.textContent?.startsWith(LONG_WORD),
    )!;
    const eventText = screen.getByText(LONG_WORD).parentElement!;
    for (const [what, text, reveal] of [
      ["payment label", paymentText, payments],
      ["event name", eventText, perHead],
    ] as const) {
      expect(text.scrollWidth, `${what} runs past its box`).toBeLessThanOrEqual(text.clientWidth);
      expect(rect(text).right, `${what} past the panel's content`).toBeLessThanOrEqual(
        rect(reveal.firstElementChild!).right + 0.5,
      );
    }
  });

  it("opens at full height on the first frame when reduced motion is asked for", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    await mount();
    const hall = line("Reception venue");
    const below = line("Ceremony venue");
    const reveal = reveals(hall)[1]!;
    const frames = await sampleOpening(
      screen.getAllByRole("button", { name: "payments (1)" })[0]!,
      reveal,
      below,
    );
    expect(frames[0]!.height).toBeGreaterThan(40);
    expect(frames[0]!.height).toBeCloseTo(frames.at(-1)!.height, 1);
  });
});

describe("BudgetView line panels, as drawn", () => {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    for (const scheme of ["light", "dark"] as const) {
      it(`draws both panels open at ${width}px, ${scheme}`, async () => {
        await page.viewport(width, height);
        await commands.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await mount();
        screen.getAllByRole("button", { name: "per head" })[0]!.click();
        screen.getAllByRole("button", { name: "payments (1)" })[0]!.click();
        await settle();
        expect(screen.getByTestId("per-head-panel").checkVisibility()).toBe(true);
        expect(screen.getByLabelText("Payment label").checkVisibility()).toBe(true);
        await page.screenshot({
          path: `${SHOTS}/open-${width}-${scheme}.png`,
          element: line("Reception venue").closest("section")!,
        });
      });
    }
  }
});
