import { cleanup, screen, within } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The arriving view's fade in the module panel (`view-arrive`, `global.css`),
 * in the real `ModuleShell` under the real `TopBar`
 * (`test-support/organiser-page.tsx`). The panel keeps its box and moves its
 * height; the view a change of module or sub-tab mounts fades in over it.
 * What is checked, reading the view's computed `opacity` on every frame:
 *
 * - the view the page opens on is at full opacity from its first frame;
 * - a sub-tab press, made deep in a list with the stack stuck, fades the new
 *   view in from below 1 to 1 and never back down, while the view bar stays the
 *   thing painted at its own centre and the view's head row stays at or below
 *   the bar's foot;
 * - a module change to a view with no `Suspense` (Guests to Budget) fades the
 *   new view in the same way;
 * - a view taking over from its `Suspense` fallback fades in too;
 * - the run sheet, whose own root swaps its loading row for the day, shows the
 *   day at once: only the view the change mounted fades;
 * - under reduced motion the new view's first frame is already at 1;
 * - the invite builder, kept mounted across its views, does not fade when the
 *   first change of the session is one of its own sub-tabs;
 * - the guests and events editors' save bars, portalled to `<body>`, are
 *   outside the faded box and drawn at full opacity while the view around
 *   their fields fades.
 *
 * Artifacts: a filmstrip of a sub-tab press at 390 and 1280, light and dark,
 * in `e2e-artifacts/cire-host/view-arrive/` at the repository root: the
 * window just after the press, two pictures mid-fade and one at rest, slowed
 * twentyfold so each lands where it is meant to; and
 * `cire/host/.vitest/view-arrive/results.json`, one pass or fail per named
 * check, with no measured values so a rerun writes the same file. Both are
 * gitignored.
 */

const { authFetch, seatingGate } = vi.hoisted(() => {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { authFetch: vi.fn(), seatingGate: { gate, open } };
});
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("@shared/toast", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {} },
  toasts: () => [],
}));
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
// The Seating module's chunk, held until a test lets it land, so its
// `Suspense` fallback is on screen first. What lands is a plain view: the
// fade belongs to the shell, not to what the view draws.
vi.mock("../../src/components/SeatingView", async () => {
  await seatingGate.gate;
  return {
    default: () => {
      const view = document.createElement("div");
      view.dataset.testid = "seating-view";
      view.textContent = "Seating";
      return view;
    },
  };
});

import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { __resetRunSheetCache } from "../../src/lib/run-sheet-store";
import { EVENTS_300, GUESTS_300, HOUSEHOLDS_300, RSVPS_300 } from "../test-support/guests-300";
import {
  type PageOptions,
  type PageRoutes,
  renderOrganiserPage,
  routeFetch,
} from "../test-support/organiser-page";

const SHOTS = "../../../../e2e-artifacts/cire-host/view-arrive";

const FULL: PageRoutes = {
  rsvps: RSVPS_300,
  guests: GUESTS_300,
  events: EVENTS_300,
  households: HOUSEHOLDS_300,
};

/** A run sheet with nothing timed: the view draws its empty day. */
const EMPTY_RUN_SHEET = { scope: "full", viewerHostId: null, items: [], people: [] };
const EMPTY_DAY = "Nothing is timed for the day yet.";

/** Every invite section empty: the builder's own fixture. */
const EMPTY_CUSTOMISATION = {
  designId: "classic",
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    palettePreset: null,
    palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
    tones: { hero: null, story: null, details: null, welcome: null },
  },
};

// ── The record ───────────────────────────────────────────────────────────────
const results: Record<string, "pass" | "fail"> = {};

/** Assert `ok`, and write the outcome under `name` for the artifact. */
function expectPass(name: string, ok: boolean, detail = "") {
  results[name] = ok ? "pass" : "fail";
  expect(ok, `${name}${detail ? ` — ${detail}` : ""}`).toBe(true);
}

beforeEach(async () => {
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

afterEach(async () => {
  cleanup();
  authFetch.mockReset();
  __resetGuestsCache();
  __resetEventsCache();
  __resetHouseholdsCache();
  __resetRunSheetCache();
  window.scrollTo(0, 0);
  document.documentElement.style.removeProperty("--motion-scale");
  delete document.documentElement.dataset.theme;
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

afterAll(async () => {
  const sorted = Object.fromEntries(
    Object.entries(results).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  await commands.writeFile(
    ".vitest/view-arrive/results.json",
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
});

// ── Page helpers ─────────────────────────────────────────────────────────────
const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1)));
    step(n);
  });

function render(opts: PageOptions, routes: PageRoutes = FULL) {
  routeFetch(authFetch, routes);
  return renderOrganiserPage(opts);
}

const rect = (el: Element) => el.getBoundingClientRect();
const viewBar = () => document.querySelector<HTMLElement>("[data-view-bar]")!;
/** The panel's measured box: the views are its children. */
const arrivals = () => document.querySelector<HTMLElement>(".view-arrive")!;
/** The panel's first child, or `null` before the panel is drawn. */
const firstView = () => document.querySelector(".view-arrive")?.firstElementChild ?? null;
const opacity = (el: Element) => Number.parseFloat(getComputedStyle(el).opacity);
/** How opaque `el` is drawn inside the panel: its opacity times every
 *  ancestor's, up to the view the panel holds. */
function shown(el: Element): number {
  let product = 1;
  for (let node: Element | null = el; node && node !== arrivals(); node = node.parentElement) {
    product *= opacity(node);
  }
  return product;
}

/** Wait until a Guests tab has drawn its list. */
async function loaded(sub: "list" | "rsvps" | "edit") {
  const selector =
    sub === "list"
      ? "[data-household-bar]"
      : sub === "edit"
        ? "[data-card-head]"
        : 'tbody > tr, ul[aria-label^="Replies"] > li';
  await vi.waitFor(() => expect(document.querySelectorAll(selector).length).toBeGreaterThan(20), {
    timeout: 10_000,
  });
  await document.fonts.ready;
  await frames();
}

/** A picture of the window, not the whole page, to `SHOTS/<name>.png`. */
async function screenshotWindow(name: string) {
  const frame = document.createElement("div");
  frame.style.cssText = "position:fixed;inset:0;pointer-events:none";
  document.body.append(frame);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, element: frame });
  frame.remove();
}

/** Whether `el` is the thing painted at its own centre. */
function onTop(el: Element): boolean {
  const r = rect(el);
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit !== null && el.contains(hit);
}

interface Frame {
  /** The panel's first child this frame; `null` while it has none. */
  view: Element | null;
  opacity: number;
  /** The view bar is painted at its own centre, where a module has one. */
  barOnTop: boolean;
  /** The view's head row is at or below the bar's foot, where it has one. */
  headClear: boolean;
}

/**
 * Read every frame from the next one until `stop()`: the panel's first child,
 * its opacity, and how it sits against the view bar.
 */
function sampleFrames() {
  const out: Frame[] = [];
  let running = true;
  const read = () => {
    if (!running) return;
    const view = firstView();
    const bar = document.querySelector("[data-view-bar]");
    const head = view?.querySelector("thead th");
    out.push({
      view,
      opacity: view ? opacity(view) : Number.NaN,
      barOnTop: bar === null || onTop(bar),
      headClear: !bar || !head || rect(head).top >= rect(bar).bottom - 1,
    });
    requestAnimationFrame(read);
  };
  requestAnimationFrame(read);
  return {
    out,
    stop: () => {
      running = false;
    },
  };
}

/** Wait until the events list is drawn: every event's row. */
async function eventsListed() {
  await vi.waitFor(
    () => expect(arrivals().textContent).toContain("Sangeet night and welcome dinner"),
    { timeout: 10_000 },
  );
  await frames();
}

/** Wait until the events editor has its rows: its actions stay invisible until then. */
async function eventsEditing() {
  await vi.waitFor(
    () => {
      const add = within(arrivals()).getByRole("button", { name: "Add event" });
      expect(getComputedStyle(add).visibility).toBe("visible");
    },
    { timeout: 10_000 },
  );
  await eventsListed();
}

/** The two editors whose save bars portal to `<body>`, and how each is made dirty. */
const EDITORS = [
  {
    module: "guests",
    listed: () => loaded("list"),
    editing: () => loaded("edit"),
    dirty: async () => {
      const field = arrivals().querySelector<HTMLInputElement>(
        "[data-edit-card] input:not([type=checkbox], [type=radio])",
      )!;
      await userEvent.type(field, "x");
    },
  },
  {
    module: "events",
    listed: eventsListed,
    editing: eventsEditing,
    dirty: () => userEvent.click(within(arrivals()).getByRole("button", { name: "Add event" })),
  },
] as const;

/** The frames from the first one that draws `view`, until it has no running transition. */
async function framesOf(sampler: ReturnType<typeof sampleFrames>, view: () => Element | null) {
  await vi.waitFor(
    () => {
      const el = view();
      expect(el).not.toBeNull();
      expect(sampler.out.some((f) => f.view === el)).toBe(true);
      expect(el!.getAnimations()).toHaveLength(0);
    },
    { timeout: 10_000 },
  );
  await frames();
  sampler.stop();
  const el = view();
  return sampler.out.filter((f) => f.view === el);
}

/** Whether the opacity never falls from one frame to the next. */
const rising = (seen: Frame[]) =>
  seen.every((f, i) => i === 0 || f.opacity >= seen[i - 1]!.opacity);

// ── The fade ─────────────────────────────────────────────────────────────────
describe("a view arriving in the module panel", () => {
  it("does not fade the view the page opens on", async () => {
    await page.viewport(1280, 800);
    const sampler = sampleFrames();
    render({ module: "guests", sub: "list" });
    const seen = await framesOf(sampler, firstView);
    expectPass(
      "first paint: at full opacity from its first frame",
      seen.length > 0 && seen.every((f) => f.opacity === 1),
      seen.map((f) => f.opacity).join(" "),
    );
    expectPass("first paint: the panel is not armed", !arrivals().hasAttribute("data-swapped"));
  });

  it("fades the new view in on a sub-tab press made deep, under the stuck bar", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    window.scrollTo(0, Math.round(document.documentElement.scrollHeight / 2));
    await frames();
    const before = arrivals().firstElementChild;
    const sampler = sampleFrames();
    await userEvent.click(within(viewBar()).getByRole("tab", { name: "RSVPs" }));
    const seen = await framesOf(sampler, () => {
      const el = arrivals().firstElementChild;
      return el === before ? null : el;
    });
    expectPass(
      "sub-tab: below full opacity on the new view's first frame",
      seen.length > 0 && seen[0]!.opacity < 1,
      seen.map((f) => f.opacity.toFixed(3)).join(" "),
    );
    expectPass("sub-tab: at full opacity by the end", seen.at(-1)?.opacity === 1);
    expectPass("sub-tab: never falls back on the way", rising(seen));
    expectPass(
      "sub-tab: the view bar stays painted over the fading view",
      seen.every((f) => f.barOnTop),
    );
    expectPass(
      "sub-tab: the view's head row stays under the bar's foot",
      seen.every((f) => f.headClear),
    );
  });

  it("fades the new view in on a module change to a view with no Suspense", async () => {
    await page.viewport(1280, 800);
    const shell = render({ module: "guests", sub: "list" });
    await loaded("list");
    const before = arrivals().firstElementChild;
    const sampler = sampleFrames();
    shell.setModule("budget");
    const seen = await framesOf(sampler, () => {
      const el = arrivals().firstElementChild;
      return el === before ? null : el;
    });
    expectPass(
      "module: below full opacity on the new view's first frame",
      seen.length > 0 && seen[0]!.opacity < 1,
      seen.map((f) => f.opacity.toFixed(3)).join(" "),
    );
    expectPass("module: at full opacity by the end", seen.at(-1)?.opacity === 1);
    expectPass("module: never falls back on the way", rising(seen));
  });

  it("fades a view in as it takes over from its Suspense fallback", async () => {
    await page.viewport(1280, 800);
    const shell = render({ module: "guests", sub: "list" });
    await loaded("list");
    shell.setModule("seating");
    const fallback = await vi.waitFor(() => {
      const el = arrivals().querySelector('[aria-busy="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await vi.waitFor(() => expect(fallback.getAnimations()).toHaveLength(0));
    expectPass(
      "suspense: the fallback is what the panel shows",
      fallback.parentElement === arrivals(),
    );
    const sampler = sampleFrames();
    seatingGate.open();
    const seen = await framesOf(sampler, () => screen.queryByTestId("seating-view"));
    expectPass(
      "suspense: below full opacity on the view's first frame",
      seen.length > 0 && seen[0]!.opacity < 1,
      seen.map((f) => f.opacity.toFixed(3)).join(" "),
    );
    expectPass("suspense: at full opacity by the end", seen.at(-1)?.opacity === 1);
    expectPass("suspense: never falls back on the way", rising(seen));
  });

  it("shows the run sheet's day at once when it replaces the view's own loading row", async () => {
    await page.viewport(1280, 800);
    const shell = render({ module: "guests", sub: "list" });
    await loaded("list");
    // The run sheet's read, held until the view is up and showing its own
    // loading row.
    const routed = authFetch.getMockImplementation()!;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    authFetch.mockImplementation(async (input: unknown) => {
      if (!String(input).includes("/run-sheet")) return routed(input);
      await held;
      return new Response(JSON.stringify(EMPTY_RUN_SHEET), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    shell.setModule("run-sheet");
    await vi.waitFor(
      () => {
        expect(authFetch.mock.calls.some(([url]) => String(url).includes("/run-sheet"))).toBe(true);
        expect(arrivals().getAnimations({ subtree: true })).toHaveLength(0);
      },
      { timeout: 10_000 },
    );
    const seen: number[] = [];
    let running = true;
    const read = () => {
      if (!running) return;
      const day = screen.queryByText(EMPTY_DAY);
      if (day) seen.push(shown(day));
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
    release();
    await vi.waitFor(() => expect(screen.queryByText(EMPTY_DAY)).not.toBeNull(), {
      timeout: 10_000,
    });
    await frames(12);
    running = false;
    expectPass(
      "run sheet: the day replaces the view's own loading row at full opacity",
      seen.length >= 10 && seen.every((o) => o === 1),
      seen.join(" "),
    );
  });

  it("puts the new view at full opacity on its first frame under reduced motion", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    const before = arrivals().firstElementChild;
    const sampler = sampleFrames();
    await userEvent.click(within(viewBar()).getByRole("tab", { name: "RSVPs" }));
    const seen = await framesOf(sampler, () => {
      const el = arrivals().firstElementChild;
      return el === before ? null : el;
    });
    expectPass(
      "reduced motion: at full opacity from the new view's first frame",
      seen.length > 0 && seen.every((f) => f.opacity === 1),
      seen.map((f) => f.opacity).join(" "),
    );
  });

  it("leaves the invite builder alone when its own sub-tab is the first change", async () => {
    await page.viewport(1280, 800);
    render({ module: "invite", sub: "template" }, { customisation: EMPTY_CUSTOMISATION });
    await vi.waitFor(() => screen.getByText("Save invite"), { timeout: 10_000 });
    await frames();
    const builder = arrivals().firstElementChild!;
    const sampler = sampleFrames();
    await userEvent.click(within(viewBar()).getByRole("tab", { name: "Style" }));
    await vi.waitFor(() => expect(arrivals().hasAttribute("data-swapped")).toBe(true));
    await frames(20);
    sampler.stop();
    const seen = sampler.out;
    expectPass("invite: the builder stays mounted", arrivals().firstElementChild === builder);
    expectPass(
      "invite: the builder is at full opacity on every frame",
      seen.length >= 20 && seen.every((f) => f.view === builder && f.opacity === 1),
      seen.map((f) => f.opacity).join(" "),
    );
  });

  for (const editor of EDITORS) {
    it(`keeps the ${editor.module} editor's save bar out of the fade`, async () => {
      await page.viewport(1280, 800);
      render({ module: editor.module, sub: "list" });
      await editor.listed();
      // Slowed, so the fade is still running when the editor has its fields.
      document.documentElement.style.setProperty("--motion-scale", "40");
      await userEvent.click(within(viewBar()).getByRole("tab", { name: "Edit" }));
      await editor.editing();
      const view = arrivals().firstElementChild!;
      await editor.dirty();
      const bar = await vi.waitFor(() => {
        const el = screen.getByText(/unsaved changes|before saving/).closest<HTMLElement>(".fixed");
        expect(el).not.toBeNull();
        return el!;
      });
      const name = `save bar (${editor.module})`;
      expectPass(
        `${name}: the view around the fields is still fading`,
        opacity(view) < 1,
        String(opacity(view)),
      );
      expectPass(`${name}: outside the faded box`, !arrivals().contains(bar));
      const chain: number[] = [];
      for (let el: Element | null = bar; el; el = el.parentElement) chain.push(opacity(el));
      expectPass(
        `${name}: drawn at full opacity, and so is everything around it`,
        chain.every((o) => o === 1),
        chain.join(" "),
      );
    });
  }
});

// ── The pictures ─────────────────────────────────────────────────────────────
describe("the fade, as a reviewer sees it", () => {
  for (const width of [390, 1280] as const) {
    for (const theme of ["light", "dark"] as const) {
      it(`films a sub-tab press at ${width} in ${theme}`, async () => {
        await page.viewport(width, width === 390 ? 844 : 800);
        document.documentElement.dataset.theme = theme;
        render({ module: "guests", sub: "list" });
        await loaded("list");
        // Slowed twentyfold, so each picture lands where it is meant to
        // whatever the machine; the last waits for the fade to end.
        document.documentElement.style.setProperty("--motion-scale", "20");
        const before = arrivals().firstElementChild;
        await userEvent.click(within(viewBar()).getByRole("tab", { name: "RSVPs" }));
        const view = arrivals().firstElementChild!;
        const shots: number[] = [];
        for (const [step, pause] of [0, 150, 600].entries()) {
          await new Promise((resolve) => setTimeout(resolve, pause));
          shots.push(opacity(view));
          await screenshotWindow(`${width}-${theme}-${step}`);
        }
        await vi.waitFor(() => expect(view.getAnimations()).toHaveLength(0), { timeout: 10_000 });
        shots.push(opacity(view));
        await screenshotWindow(`${width}-${theme}-3`);
        expectPass(`film ${width} ${theme}: the RSVP view is what is filmed`, view !== before);
        expectPass(
          `film ${width} ${theme}: the pictures run from mid-fade to rest`,
          shots.length > 0 && shots[0]! < 1 && shots.at(-1) === 1,
          shots.join(" "),
        );
      });
    }
  }
});
