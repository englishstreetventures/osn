import { cleanup, render, screen } from "@solidjs/testing-library";
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
 * - every control in an open panel keeps its whole focus ring inside the
 *   `Reveal`'s clip;
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
 *  panel's height, how far the next line has moved, and where focus is. */
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
      height: reveal.getBoundingClientRect().height,
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
      expect(reveal.getBoundingClientRect().height).toBe(0);

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
      expect(reveal.getBoundingClientRect().height).toBeGreaterThan(40);
      toggle.click();
      await nextFrame();
      expect(reveal.getBoundingClientRect().height).toBe(0);
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

  it("keeps every control's focus ring inside the panel's clip", async () => {
    await mount();
    const root = getComputedStyle(document.documentElement);
    const ring =
      parseFloat(root.getPropertyValue("--focus-ring-width")) +
      parseFloat(root.getPropertyValue("--focus-ring-offset"));
    expect(ring).toBe(4);
    const hall = line("Reception venue");
    const below = line("Ceremony venue");
    for (const [name, index] of [
      ["payments (1)", 1],
      ["per head", 0],
    ] as const) {
      const reveal = reveals(hall)[index]!;
      await sampleOpening(screen.getAllByRole("button", { name })[0]!, reveal, below);
      const clip = (reveal.firstElementChild as HTMLElement).getBoundingClientRect();
      const controls = [
        ...reveal.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]"),
      ].filter((el) => el.getClientRects().length > 0);
      expect(controls.length, `${name}: controls`).toBeGreaterThan(2);
      for (const el of controls) {
        const box = el.getBoundingClientRect();
        const what = `${name}: ${el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName}`;
        expect(box.top - ring, `${what} top`).toBeGreaterThanOrEqual(clip.top - 0.5);
        expect(box.bottom + ring, `${what} bottom`).toBeLessThanOrEqual(clip.bottom + 0.5);
        expect(box.left - ring, `${what} left`).toBeGreaterThanOrEqual(clip.left - 0.5);
        expect(box.right + ring, `${what} right`).toBeLessThanOrEqual(clip.right + 0.5);
      }
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
