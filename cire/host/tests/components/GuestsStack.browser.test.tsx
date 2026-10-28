import { cleanup, screen, within } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The stuck stack on the Guests module, at the size a wedding reaches: 300
 * households, five events, 900 guests, in the real `ModuleShell` under the
 * real `TopBar` (`test-support/organiser-page.tsx`).
 *
 * As the page scrolls, layers hold at the top of the window, each one's top at
 * the foot of the one above: the top bar, the module's view bar, then the
 * view's own — the RSVP table's head row; the households' head strip and the
 * bar of the household on screen; the editor's card header. What is checked,
 * at 1280×800 and 390×844, on each tab:
 *
 * - the layers meet to the pixel, and the whole stack stays inside the owner's
 *   limit (220px on a laptop, 200px on a phone), the fixed rows at their
 *   declared heights;
 * - the household bar that holds is the household on screen, and no other;
 * - a search, made deep in a list, brings the list back to the stack's foot and
 *   leaves focus in the field; made at the top, it moves nothing;
 * - a sub-tab change made with the bar stuck puts the new panel at the foot,
 *   and does not move again when its data lands;
 * - a control taking focus deep in a list is never left under the stack;
 * - a phone scrolls nothing sideways; the rail stays under the top bar;
 * - each view goes narrow below the panel width its wide layout needs and no
 *   sooner, with every action still on screen and reachable either side;
 * - the invite builder's own sticky tabs sit under the bar, or under the top
 *   bar where a module has no bar, and a module with no bar leaves no
 *   `--bar-h` behind;
 * - a reply filter, a sort or another event, chosen deep in the RSVP list,
 *   brings it back to the foot as a search does;
 * - the panel's hold lets go when the data lands, when it fails, and when the
 *   host leaves first; `--bar-h` is written once per settled height, not on
 *   every frame of the bar's slide;
 * - an invite-message link followed from deep in a list lands its heading on
 *   screen;
 * - icon-only controls show their names in the page's one tooltip on keyboard
 *   focus, and a household's mark its explanation on hover; no household
 *   control or editor head mounts a popup of its own.
 *
 * Artifacts: a screenshot per tab, size and theme, scrolled, in `__screenshots__/`
 * beside this file; and `cire/host/.vitest/guests-stack/results.json`, one
 * pass or fail per named check, with no pixel values so a rerun writes the same
 * file. Both are gitignored.
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

import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { EVENTS_300, GUESTS_300, HOUSEHOLDS_300, RSVPS_300 } from "../test-support/guests-300";
import {
  type PageOptions,
  type PageRoutes,
  renderOrganiserPage,
  routeFetch,
  topBar,
} from "../test-support/organiser-page";

const SIZES = [
  [1280, 800],
  [390, 844],
] as const;
const LIMIT = { 1280: 220, 390: 200 } as const;
const TABS = [
  ["list", "Households"],
  ["edit", "Edit"],
  ["rsvps", "RSVPs"],
] as const;

const FULL: PageRoutes = {
  rsvps: RSVPS_300,
  guests: GUESTS_300,
  events: EVENTS_300,
  households: HOUSEHOLDS_300,
};

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

beforeAll(() => {
  // Positions are what is read here; no transition may sit between a change
  // and its measurement.
  const style = document.createElement("style");
  style.dataset.noTransitions = "";
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
});

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  __resetGuestsCache();
  __resetEventsCache();
  __resetHouseholdsCache();
  window.scrollTo(0, 0);
  document.querySelector("style[data-unstick]")?.remove();
  delete document.documentElement.dataset.theme;
});

afterAll(async () => {
  const sorted = Object.fromEntries(
    Object.entries(results).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  await commands.writeFile(
    ".vitest/guests-stack/results.json",
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
});

// ── Page helpers ─────────────────────────────────────────────────────────────
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Wait until the tab on screen has drawn its list. */
async function loaded(sub: string) {
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

const rect = (el: Element) => el.getBoundingClientRect();
const viewBar = () => document.querySelector<HTMLElement>("[data-view-bar]")!;

/** The one of `els` whose top sits at `y`, to the pixel. */
const at = (els: Iterable<Element>, y: number) =>
  [...els].find((el) => Math.abs(rect(el).top - y) <= 1);

/** The stack's layers on the tab on screen, top down, as they hold now. */
function layers(sub: string, compact: boolean): { name: string; el: Element | undefined }[] {
  const out: { name: string; el: Element | undefined }[] = [
    { name: "top bar", el: topBar() },
    { name: "view bar", el: viewBar() },
  ];
  const foot = rect(viewBar()).bottom;
  if (sub === "rsvps" && !compact) {
    out.push({ name: "head row", el: document.querySelector("thead th") ?? undefined });
  }
  if (sub === "list") {
    let under = foot;
    if (!compact) {
      const strip = document.querySelector("[data-head-strip]") ?? undefined;
      out.push({ name: "head strip", el: strip });
      if (strip) under = rect(strip).bottom;
    }
    out.push({
      name: "household bar",
      el: at(document.querySelectorAll("[data-household-bar]"), under),
    });
  }
  if (sub === "edit") {
    out.push({ name: "card header", el: at(document.querySelectorAll("[data-card-head]"), foot) });
  }
  return out;
}

/** The line a view's own rows stick under: the chrome, the bar, the heads. */
function rowLine(scope: Element): number {
  return cssPx("calc(var(--chrome-h) + var(--bar-h, 0px) + var(--heads-h, 0px))", scope);
}

/**
 * Scroll to the middle of the page, well into the list — and, on a tab whose
 * layers belong to one household or card, 60px into one, so its layer is held
 * rather than being pushed out by the end of the one before.
 */
async function scrollMid(sub = "rsvps") {
  window.scrollTo(0, Math.round(document.documentElement.scrollHeight / 2));
  await frames();
  const unit =
    sub === "list" ? "[role=group][aria-labelledby]" : sub === "edit" ? "[data-edit-card]" : null;
  if (!unit) return;
  const all = [...document.querySelectorAll(unit)];
  const line = rowLine(all[0]!);
  const host = all.find((el) => rect(el).bottom > line + 300) ?? all.at(-1)!;
  window.scrollTo(0, scrollY + rect(host).top - line + 60);
  await frames();
}

/** A picture of the window, not the whole page. */
async function screenshotWindow(name: string) {
  const frame = document.createElement("div");
  frame.style.cssText = "position:fixed;inset:0;pointer-events:none";
  document.body.append(frame);
  await page.screenshot({
    path: `__screenshots__/GuestsStack.browser.test.tsx/${name}.png`,
    element: frame,
  });
  frame.remove();
}

/** Whether `el` is the thing painted at its own centre. */
function onTop(el: Element): boolean {
  const r = rect(el);
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit !== null && el.contains(hit);
}

/** Whether `el` is wholly inside the window and painted on top. */
function reachable(el: Element): boolean {
  const r = rect(el);
  return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && onTop(el);
}

/** The px height of a CSS length, measured in the page's own scope. */
function cssPx(value: string, scope: Element = document.querySelector("main")!): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;height:${value}`;
  scope.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}

// ── The stack ────────────────────────────────────────────────────────────────
describe("the stuck stack on Guests", () => {
  for (const [width, height] of SIZES) {
    const compact = width === 390;
    for (const [sub, label] of TABS) {
      it(`${label} at ${width}: the layers meet and fit under ${LIMIT[width]}px`, async () => {
        await page.viewport(width, height);
        render({ module: "guests", sub });
        await loaded(sub);
        await scrollMid(sub);
        const stack = layers(sub, compact);
        for (const layer of stack) {
          expectPass(`${label} ${width}: ${layer.name} holds`, layer.el !== undefined);
        }
        for (let i = 1; i < stack.length; i += 1) {
          const above = rect(stack[i - 1]!.el!).bottom;
          const top = rect(stack[i]!.el!).top;
          expectPass(
            `${label} ${width}: ${stack[i]!.name} meets the ${stack[i - 1]!.name}`,
            Math.abs(top - above) <= 1,
            `${top} vs ${above}`,
          );
          expectPass(`${label} ${width}: ${stack[i]!.name} is on top`, onTop(stack[i]!.el!));
        }
        const total = rect(stack.at(-1)!.el!).bottom;
        expectPass(
          `${label} ${width}: the stack is inside its limit`,
          total <= LIMIT[width],
          `${total}px`,
        );
        // The fixed rows are the heights the stylesheet declares, which is
        // what a focused control's scroll margin adds up.
        if (sub === "list") {
          const bar = stack.at(-1)!.el!;
          expectPass(
            `${label} ${width}: the household bar is its declared height`,
            Math.abs(rect(bar).height - cssPx("var(--hh-bar-h)")) <= 0.5,
          );
        }
        if (sub === "edit") {
          const head = stack.at(-1)!.el!;
          const declared = cssPx("calc(var(--card-head-h) + var(--head-strip-h) + 1px)");
          expectPass(
            `${label} ${width}: the card header is its declared height`,
            Math.abs(rect(head).height - declared) <= 0.5,
          );
        }
        for (const theme of ["light", "dark"] as const) {
          document.documentElement.dataset.theme = theme;
          await frames();
          await screenshotWindow(`${sub}-${width}-scrolled-${theme}`);
        }
      });
    }

    it(`at ${width}: --chrome-h is the top bar's height`, async () => {
      await page.viewport(width, height);
      render({ module: "guests", sub: "list" });
      await loaded("list");
      expectPass(
        `chrome ${width}: --chrome-h is the top bar`,
        Math.abs(cssPx("var(--chrome-h)") - rect(topBar()).height) <= 0.5,
      );
    });

    it(`Households at ${width}: the bar that holds is the household on screen`, async () => {
      await page.viewport(width, height);
      render({ module: "guests", sub: "list" });
      await loaded("list");
      const groups = [...document.querySelectorAll<HTMLElement>("[role=group][aria-labelledby]")];
      const k = 120;
      const group = groups[k]!;
      const name = document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent;
      const ownBar = group.querySelector("[data-household-bar]")!;
      window.scrollTo(0, scrollY + rect(group).top - rowLine(group) + 60);
      await frames();
      const under2 = compact
        ? rect(viewBar()).bottom
        : rect(document.querySelector("[data-head-strip]")!).bottom;
      const held = at(document.querySelectorAll("[data-household-bar]"), under2);
      expectPass(
        `Households ${width}: the held bar is household k's`,
        held === ownBar,
        String(name),
      );
      expectPass(`Households ${width}: the held bar is painted`, onTop(ownBar));
      const earlier = groups.slice(0, k).map((g) => g.querySelector("[data-household-bar]")!);
      expectPass(
        `Households ${width}: no earlier household bar shows`,
        earlier.every((bar) => rect(bar).bottom <= under2 + 1),
      );
    });

    it(`at ${width}: a focused control deep in the list is not left under the stack`, async () => {
      await page.viewport(width, height);
      render({ module: "guests", sub: "rsvps" });
      await loaded("rsvps");
      await scrollMid();
      const foot = rect(layers("rsvps", compact).at(-1)!.el!).bottom;
      // A reply button well down the screen, then the page scrolled so it
      // sits just under the stack, where the browser would take it for on
      // screen if the stack did not say otherwise.
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>("button[aria-label*=' reply for ']"),
      ];
      const target = buttons.find((b) => rect(b).top > foot + 100)!;
      expectPass(`focus ${width}: a button below the stack`, target !== undefined);
      window.scrollTo(0, scrollY + rect(target).top - (foot - 20));
      await frames();
      expectPass(`focus ${width}: the button is under the stack`, rect(target).top < foot);
      target.focus();
      await frames();
      expectPass(
        `focus ${width}: the focused button is below the stack`,
        rect(target).top >= foot - 1,
      );
      expectPass(`focus ${width}: the focused button is painted`, onTop(target));
    });

    it(`at ${width}: the household list's focus clears its bar and head strip`, async () => {
      await page.viewport(width, height);
      render({ module: "guests", sub: "list" });
      await loaded("list");
      await scrollMid("list");
      // A plus-one switch well down the screen, scrolled to just under the
      // household's held bar, then focused: the browser must bring it out.
      const stackFoot = () => rect(layers("list", compact).at(-1)!.el!).bottom;
      const foot = stackFoot();
      const switches = [...document.querySelectorAll<HTMLElement>("[role=switch]")];
      const target = switches.find((el) => rect(el.closest("label")!).top > foot + 100)!;
      expectPass(`households focus ${width}: a switch below the stack`, target !== undefined);
      const label = target.closest("label")!;
      window.scrollTo(0, scrollY + rect(label).top - (foot - 10));
      await frames();
      expectPass(
        `households focus ${width}: the switch is under the stack`,
        rect(label).top < foot,
      );
      target.focus();
      await frames();
      const held = layers("list", compact).at(-1)!.el;
      expectPass(
        `households focus ${width}: the focused switch is below the stack`,
        held !== undefined ? rect(label).top >= rect(held).bottom - 1 : rect(label).top >= foot - 1,
      );
    });
  }

  // Phones only: a laptop's tables are wide by design.
  it(`at 390: nothing on RSVPs or Households scrolls sideways`, async () => {
    await page.viewport(390, 844);
    for (const sub of ["rsvps", "list"] as const) {
      const view = render({ module: "guests", sub });
      await loaded(sub);
      const lists = [
        ...document.querySelectorAll<HTMLElement>(
          '[role=group] ul, ul[aria-label^="Replies"], [role=group] li, ul[aria-label^="Replies"] > li',
        ),
      ];
      expectPass(
        `phone ${sub}: no list is wider than its box`,
        lists.length > 0 && lists.every((el) => el.scrollWidth <= el.clientWidth + 0.5),
      );
      expectPass(
        `phone ${sub}: the page is no wider than the window`,
        document.documentElement.scrollWidth <= innerWidth,
      );
      view.unmount();
      __resetGuestsCache();
      __resetEventsCache();
    }
  });

  // Laptops only: a phone has no rail, only the module sheet.
  it(`at 1280: the rail stays under the top bar`, async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    await scrollMid("list");
    const rail = screen.getByRole("navigation", { name: "Wedding modules" });
    const first = rail.querySelector("button, a")!;
    expectPass(
      "rail 1280: its first entry is below the top bar",
      rect(first).top >= rect(topBar()).bottom,
    );
  });
});

// ── One popup for the page ───────────────────────────────────────────────────
/** The page's one tooltip panel, if open. `aria-hidden`, so found by attribute. */
const tipPanel = () => document.querySelector<HTMLElement>("[data-tip-panel]");

describe("one popup for the page, not one per control", () => {
  for (const [width, height] of SIZES) {
    it(`Households at ${width}: no household control mounts a tooltip or menu of its own`, async () => {
      await page.viewport(width, height);
      render({ module: "guests", sub: "list" });
      await loaded("list");
      const bars = document.querySelectorAll("[data-household-bar]");
      const controls = document.querySelectorAll("[data-household-bar] button");
      expectPass(`roots ${width}: every household is drawn`, bars.length === 300);
      expectPass(`roots ${width}: their controls are drawn`, controls.length >= 300);
      // Kobalte's own triggers carry these attributes whatever their state.
      expectPass(
        `roots ${width}: no household control is a Kobalte trigger`,
        document.querySelector(
          "[data-household-bar] [data-closed], [data-household-bar] [data-expanded], [data-household-bar] [aria-haspopup='true']",
        ) === null,
      );
      expectPass(`roots ${width}: no menu is open`, document.querySelector("[role=menu]") === null);
    });
  }

  it("at 390: names each icon-only control in the tooltip on keyboard focus", async () => {
    await page.viewport(390, 844);
    render({ module: "guests", sub: "edit" });
    await loaded("edit");
    const add = within(viewBar()).getByRole("button", { name: "Add household" });
    add.focus();
    await vi.waitFor(() => expect(tipPanel()?.textContent).toBe("Add household"));
    expectPass(
      "tip 390: Add household's panel is for the eye only",
      tipPanel()!.getAttribute("aria-hidden") === "true",
    );
    expectPass(
      "tip 390: Add household is not described by it",
      !add.hasAttribute("aria-describedby"),
    );
    const tab = within(viewBar()).getByRole("tab", { name: "RSVPs" });
    tab.focus();
    await vi.waitFor(() => expect(tipPanel()?.textContent).toBe("RSVPs"));
    expectPass(
      "tip 390: the icon-only sub-tab is not described by it",
      !tab.hasAttribute("aria-describedby"),
    );
    // The mode switch keeps its own description, the hint under the bar.
    const mode = within(viewBar()).getByRole("radio", { name: "Spreadsheet import" });
    const hint = mode.getAttribute("aria-describedby");
    mode.focus();
    await vi.waitFor(() => expect(tipPanel()?.textContent).toBe("Spreadsheet import"));
    expectPass(
      "tip 390: the mode switch is described by its hint alone",
      hint !== null &&
        !hint.includes(" ") &&
        mode.getAttribute("aria-describedby") === hint &&
        document.getElementById(hint)?.textContent?.trim() !== "",
    );
  });

  it("at 1280: shows no tooltip for a sub-tab whose words are on screen", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    within(viewBar()).getByRole("tab", { name: "RSVPs" }).focus();
    await wait(400);
    expectPass("tip 1280: a labelled sub-tab shows none", tipPanel() === null);
  });

  it("at 1280: explains a household's mark on hover", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    const opened = [
      ...document.querySelectorAll<HTMLElement>("[data-household-bar] [data-tip]"),
    ].find((el) => el.textContent?.includes("Opened"))!;
    opened.scrollIntoView({ block: "center" });
    await frames();
    await userEvent.hover(opened);
    await vi.waitFor(() =>
      expect(tipPanel()?.textContent?.startsWith("A guest opened this invite")).toBe(true),
    );
    expectPass(
      "mark 1280: the panel is painted above the mark",
      rect(tipPanel()!).bottom <= rect(opened).top + 1,
    );
  });
});

// ── Searches and view changes ────────────────────────────────────────────────
describe("moving within the stack", () => {
  const searchbox = () => within(viewBar()).getByRole("searchbox");

  it("brings a long search result back to the foot of the stack, focus kept", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "rsvps" });
    await loaded("rsvps");
    window.scrollTo(0, document.documentElement.scrollHeight);
    await frames();
    const box = searchbox();
    box.focus({ preventScroll: true });
    // A surname a twelfth of the list carries: far more than a screen of rows.
    await userEvent.fill(box, "Sharma");
    await frames();
    const rows = document.querySelectorAll("tbody > tr");
    expectPass("search deep: more than a screen of rows is left", rows.length > 20);
    const headFoot = rect(document.querySelector("thead th")!).bottom;
    expectPass(
      "search deep: the first row sits at the stack's foot",
      Math.abs(rect(rows[0]!).top - headFoot) <= 1,
      `${rect(rows[0]!).top} vs ${headFoot}`,
    );
    expectPass("search deep: focus stays in the field", document.activeElement === box);
  });

  it("moves nothing for a search made at the top", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "rsvps" });
    await loaded("rsvps");
    await userEvent.fill(searchbox(), "Sharma");
    await frames();
    expectPass("search top: the page does not move", window.scrollY === 0);
  });

  it("leaves a short result out from under the stack", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "rsvps" });
    await loaded("rsvps");
    window.scrollTo(0, document.documentElement.scrollHeight);
    await frames();
    // One household's code: a row or two, far shorter than the page was.
    await userEvent.fill(searchbox(), GUESTS_300[200]!.publicId);
    await frames();
    const rows = document.querySelectorAll("tbody > tr");
    expectPass("search short: a few rows are left", rows.length > 0 && rows.length < 6);
    expectPass(
      "search short: the first row is not under the stack",
      rect(rows[0]!).top >= rect(document.querySelector("thead th")!).bottom - 1,
    );
  });

  // The search is not the only thing that redraws the list: a reply filter, a
  // sort and another event do too, and each is pressed deep in the list.
  const TRIGGERS = [
    ["the No reply chip", () => within(viewBar()).getByRole("button", { name: /^No reply/ })],
    [
      "the Guest head's sort",
      () =>
        within(document.querySelector<HTMLElement>("thead")!).getByRole("button", {
          name: "Guest",
        }),
    ],
    ["the second event", () => within(viewBar()).getAllByRole("tab", { name: /, \d+ guests/ })[1]!],
  ] as const;
  for (const [what, control] of TRIGGERS) {
    it(`brings the list back to the foot for ${what}, focus kept`, async () => {
      await page.viewport(1280, 800);
      render({ module: "guests", sub: "rsvps" });
      await loaded("rsvps");
      window.scrollTo(0, document.documentElement.scrollHeight);
      await frames();
      const target = control();
      await userEvent.click(target);
      await frames();
      const rows = document.querySelectorAll("tbody > tr");
      const headFoot = rect(document.querySelector("thead th")!).bottom;
      const first = rect(rows[0]!).top;
      expectPass(`${what}: the first row is not under the stack`, first >= headFoot - 1);
      // Where more than a screen of rows is left, the first sits at the foot.
      expectPass(
        `${what}: the first row sits at the stack's foot`,
        rows.length <= 20 || Math.abs(first - headFoot) <= 1,
        `${first} vs ${headFoot}, ${rows.length} rows`,
      );
      expectPass(`${what}: focus stays on the control pressed`, document.activeElement === target);
    });
  }

  it("brings a household search back to the foot, once the debounce settles", async () => {
    await page.viewport(390, 844);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    window.scrollTo(0, document.documentElement.scrollHeight);
    await frames();
    await userEvent.fill(searchbox(), "Sharma");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-household-bar]").length).toBeLessThan(40),
    );
    await frames();
    const first = document.querySelector("[data-household-bar]")!;
    expectPass(
      "household search: the first household is not under the stack",
      rect(first).top >= rect(viewBar()).bottom - 1,
    );
    expectPass(
      "household search: focus stays in the field",
      document.activeElement === searchbox(),
    );
  });

  it("puts the new panel at the foot on a sub-tab change made deep, and holds it there", async () => {
    await page.viewport(1280, 800);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(
      { module: "guests", sub: "list" },
      {
        ...FULL,
        rsvps: async () => {
          await held;
          return RSVPS_300;
        },
      },
    );
    await loaded("list");
    await scrollMid();
    await userEvent.click(within(viewBar()).getByRole("tab", { name: "RSVPs" }));
    await frames();
    const panel = document.getElementById("subpanel-guests")!;
    const foot = () => rect(viewBar()).bottom;
    expectPass(
      "sub-tab deep: the new panel's top is at the foot while it loads",
      Math.abs(rect(panel).top - foot()) <= 1,
      `${rect(panel).top} vs ${foot()}`,
    );
    const before = window.scrollY;
    release();
    await loaded("rsvps");
    expectPass(
      "sub-tab deep: the page does not move again when the data lands",
      window.scrollY === before,
    );
    expectPass(
      "sub-tab deep: the panel's top is still at the foot",
      Math.abs(rect(panel).top - foot()) <= 1,
    );
    expectPass("sub-tab deep: the hold lets go once the data is in", panel.style.minHeight === "");
  });

  it("lets the panel go when the new view's read fails", async () => {
    await page.viewport(1280, 800);
    render(
      { module: "guests", sub: "list" },
      { ...FULL, rsvps: () => new Response("{}", { status: 500 }) },
    );
    await loaded("list");
    await scrollMid("list");
    await userEvent.click(within(viewBar()).getByRole("tab", { name: "RSVPs" }));
    const panel = document.getElementById("subpanel-guests")!;
    await vi.waitFor(() => expect(within(panel).getByText(/Could not load RSVPs/)).toBeTruthy());
    await frames();
    expectPass("hold failed: the panel is not held a screen tall", panel.style.minHeight === "");
  });

  it("lets the panel go when the host leaves before the data lands", async () => {
    await page.viewport(1280, 800);
    const never = new Promise<never>(() => {});
    render({ module: "guests", sub: "list" }, { ...FULL, rsvps: () => never });
    await loaded("list");
    await scrollMid("list");
    await userEvent.click(within(viewBar()).getByRole("tab", { name: "RSVPs" }));
    await frames();
    const panel = document.getElementById("subpanel-guests")!;
    expectPass("hold left: held while RSVPs load", panel.style.minHeight !== "");
    await userEvent.click(within(viewBar()).getByRole("tab", { name: "Households" }));
    await loaded("list");
    expectPass("hold left: let go with RSVPs gone", panel.style.minHeight === "");
  });

  // A short window, so the invite builder the link opens is long enough that
  // the page is not simply clamped back to its top.
  it("lands the heading an invite-message link opens on screen, from deep in a list", async () => {
    await page.viewport(1280, 400);
    render({ module: "guests", sub: "list" }, { ...FULL, customisation: EMPTY_CUSTOMISATION });
    await loaded("list");
    const link = screen.getByRole("button", { name: "Invite, Design, Message" });
    // The links just under the view bar: the module's heading has gone under
    // the top bar.
    window.scrollTo(0, scrollY + rect(link).top - rect(viewBar()).bottom - 4);
    await frames();
    expectPass(
      "link deep: the module's heading is under the top bar",
      rect(screen.getByRole("heading", { level: 2, name: "Guests" })).bottom <=
        rect(topBar()).bottom,
    );
    await userEvent.click(link);
    await vi.waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    await vi.waitFor(() => screen.getByText("Save invite"), { timeout: 10_000 });
    await frames();
    const heading = document.activeElement as HTMLElement;
    expectPass("link deep: the page moved rather than clamping to its top", scrollY > 0);
    expectPass(
      "link deep: the heading it lands on is below the top bar",
      rect(heading).top >= rect(topBar()).bottom - 1,
      `${rect(heading).top} vs ${rect(topBar()).bottom}`,
    );
    expectPass("link deep: the heading is painted", onTop(heading));
  });

  it("moves nothing on a sub-tab change made at the top", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    await userEvent.click(within(viewBar()).getByRole("tab", { name: "RSVPs" }));
    await loaded("rsvps");
    expectPass("sub-tab top: the page does not move", window.scrollY === 0);
  });

  it("follows the bar's height into --bar-h, and holds layers with the 0px fallback", async () => {
    await page.viewport(1280, 800);
    const view = render({ module: "guests", sub: "list" });
    await loaded("list");
    const shell = viewBar().closest(".\\@container\\/shell")!;
    const barH = () => cssPx("var(--bar-h)", shell.querySelector("[data-head-strip]")!);
    expectPass("bar-h: one row", Math.abs(barH() - rect(viewBar()).height) <= 0.5);
    view.setSub("rsvps");
    await loaded("rsvps");
    await frames();
    expectPass("bar-h: the bar grows to two rows", rect(viewBar()).height > 80);
    expectPass(
      "bar-h: follows the second row",
      Math.abs(cssPx("var(--bar-h)", document.querySelector("thead")!) - rect(viewBar()).height) <=
        0.5,
    );
    // Before the bar's first measure there is no --bar-h; a layer then holds
    // at the top bar's foot rather than nowhere.
    (shell as HTMLElement).style.removeProperty("--bar-h");
    const th = document.querySelector("thead th")!;
    expectPass(
      "bar-h: an unset --bar-h falls back to 0px",
      Math.abs(parseFloat(getComputedStyle(th).top) - rect(topBar()).height) <= 0.5,
    );
  });

  it("writes --bar-h once per settled height, ahead of the bar's slide", async () => {
    await page.viewport(1280, 800);
    const view = render({ module: "guests", sub: "list" });
    await loaded("list");
    const shell = viewBar().closest<HTMLElement>(".\\@container\\/shell")!;
    const barH = () => parseFloat(shell.style.getPropertyValue("--bar-h"));
    const hairline = parseFloat(getComputedStyle(viewBar()).borderBottomWidth);
    const writes: string[] = [];
    const set = shell.style.setProperty.bind(shell.style);
    shell.style.setProperty = (name: string, value: string | null, priority?: string) => {
      if (name === "--bar-h") writes.push(String(value));
      set(name, value, priority);
    };
    // This case needs the slide itself: the file's transition kill is lifted.
    const still = document.querySelector<HTMLStyleElement>("style[data-no-transitions]")!;
    still.sheet!.disabled = true;
    try {
      view.setSub("rsvps");
      // While the bar slides to its new height, the layers under it already
      // hold at the height it is sliding to: --bar-h is the settled height,
      // not the bar's height of the moment.
      let midSlide = 0;
      let ahead = 0;
      for (let i = 0; i < 30; i += 1) {
        await frames(1);
        const frame = viewBar().firstElementChild as HTMLElement;
        const settled = rect(frame.firstElementChild!).height + hairline;
        if (frame.style.height !== "" && Math.abs(rect(viewBar()).height - settled) > 1) {
          midSlide += 1;
          if (Math.abs(barH() - settled) <= 0.5) ahead += 1;
        }
      }
      expectPass("bar-h writes: the slide was seen", midSlide > 0);
      expectPass(
        "bar-h writes: mid-slide, --bar-h is already the settled height",
        ahead === midSlide,
        `${ahead} of ${midSlide}`,
      );
      await loaded("rsvps");
      await wait(600);
      // One write per height the bar settles at: the placeholder row while the
      // replies load, then the loaded row, which is the same height today.
      expectPass(
        "bar-h writes: at most one per settled height",
        writes.length >= 1 && writes.length <= 2,
        writes.join(", "),
      );
      expectPass(
        "bar-h writes: the last is the settled bar",
        Math.abs(barH() - rect(viewBar()).height) <= 0.5,
      );
    } finally {
      still.sheet!.disabled = false;
    }
  });

  it("keeps the editor's head strip level with its table as it scrolls sideways", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "edit" });
    await loaded("edit");
    const card = document.querySelectorAll("[data-edit-card]")[3]!;
    const box = card.querySelector("section")!;
    const strip = card.querySelector<HTMLElement>("[data-head-strip]")!;
    expectPass("strip: the table is wider than its box", box.scrollWidth > box.clientWidth);
    box.scrollLeft = 160;
    await vi.waitFor(() => expect(strip.scrollLeft).toBe(box.scrollLeft));
    expectPass("strip: follows the box", strip.scrollLeft === box.scrollLeft);
    // The columns line up: each head over its own column's cells.
    const heads = [...strip.querySelectorAll("th")];
    const cells = [...box.querySelectorAll("tbody tr:first-child > td")];
    expectPass(
      "strip: every head is over its column",
      heads.length === cells.length &&
        heads.every((h, i) => Math.abs(rect(h).left - rect(cells[i]!).left) <= 1),
    );
    // Another card's strip is its own.
    const other = document.querySelectorAll<HTMLElement>("[data-edit-card] [data-head-strip]")[0]!;
    expectPass("strip: another card's strip stays put", other.scrollLeft === 0);
  });

  it("shows a cut-short event name whole, from a button", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "edit" });
    await loaded("edit");
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          "[data-head-strip] button[aria-label='Event: Sangeet night and welcome dinner']",
        ),
      ).not.toBeNull(),
    );
    const card = document.querySelector("[data-edit-card]")!;
    const button = card.querySelector<HTMLButtonElement>(
      "[data-head-strip] button[aria-label='Event: Sangeet night and welcome dinner']",
    )!;
    button.focus();
    await userEvent.keyboard("{Enter}");
    const panel = await screen.findByRole("dialog");
    expectPass(
      "event name: the whole name opens",
      panel.textContent?.includes("Sangeet night and welcome dinner") === true,
    );
    expectPass(
      "event name: the head says it is open",
      button.getAttribute("aria-expanded") === "true",
    );
    // The short name is no button.
    expectPass(
      "event name: a name that fits is plain",
      card.querySelector("[data-head-strip] button[aria-label='Event: Mehndi']") === null,
    );
    // One popover for the editor: no head is a Kobalte trigger of its own.
    expectPass(
      "event name: no head mounts a popover of its own",
      document.querySelector(
        "[data-head-strip] [data-closed], [data-head-strip] [data-expanded]",
      ) === null,
    );
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectPass(
      "event name: Escape gives focus back to the head",
      document.activeElement === button,
    );
    expectPass(
      "event name: the head says it is closed",
      button.getAttribute("aria-expanded") === "false",
    );
    // Another card's head opens the same popover there.
    const other = document
      .querySelectorAll("[data-edit-card]")[1]!
      .querySelector<HTMLButtonElement>(
        "[data-head-strip] button[aria-label='Event: Sangeet night and welcome dinner']",
      )!;
    other.focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("dialog");
    expectPass(
      "event name: one popover at a time",
      document.querySelectorAll("[role=dialog]").length === 1,
    );
    // Its head gone — the card redrawn, or the column grown to fit — the
    // popover goes too, rather than stay open over nothing.
    other.remove();
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectPass("event name: no popover outlives its head", screen.queryByRole("dialog") === null);
  });
});

// ── Headers for assistive technology ─────────────────────────────────────────
interface AXNode {
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
}
interface Frame {
  frame: { id: string; url: string };
  childFrames?: Frame[];
}

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

describe("the households' heads, as Chrome exposes them", () => {
  it("names four column heads in every household table, and none in the strip", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    const tables = document.querySelectorAll("[role=group] table").length;
    const nodes = await accessibilityTree();
    const heads = nodes.filter((n) => !n.ignored && n.role?.value === "columnheader");
    const names = new Set(heads.map((n) => n.name?.value));
    expectPass(
      "ax: one head per column per household",
      heads.length === tables * 4,
      `${heads.length}`,
    );
    expectPass(
      "ax: the heads are named",
      names.size === 4 && ["Guest", "Events", "Plus-one", "Code"].every((n) => names.has(n)),
    );
  });
});

// ── Where each view goes narrow ──────────────────────────────────────────────
/** Size the page so the module panel is `target` px wide. */
async function panelTo(target: number) {
  const main = document.querySelector<HTMLElement>("main")!;
  const panel = () => document.querySelector(".\\@container\\/panel")!;
  for (let i = 0; i < 4; i += 1) {
    const now = rect(panel()).width;
    if (Math.abs(now - target) < 0.25) return;
    const width = rect(main).width + (target - now);
    main.style.setProperty("--page-max", `${width}px`);
    await frames(3);
  }
}

describe("each view goes narrow at its own line", () => {
  it("draws the households' tables down to 46rem, and every action stays reachable", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    const firstBar = () => document.querySelector("[data-household-bar]")!;
    await panelTo(46 * 16 + 1);
    expectPass(
      "narrow households: wide just above the line",
      document.querySelector("[data-head-strip]") !== null,
    );
    const actions = [...firstBar().querySelectorAll("button")];
    expectPass("narrow households: the bar has its icons", actions.length >= 3);
    expectPass("narrow households: every action is reachable", actions.every(reachable));
    // The confirmation takes the icons' place in the same row.
    await userEvent.click(
      within(firstBar() as HTMLElement).getByRole("button", { name: "Deactivate" }),
    );
    const confirm = within(firstBar() as HTMLElement).getByRole("button", { name: "Confirm" });
    const cancel = within(firstBar() as HTMLElement).getByRole("button", { name: "Cancel" });
    expectPass(
      "narrow households: the confirmation is reachable",
      reachable(confirm) && reachable(cancel),
    );
    expectPass(
      "narrow households: the bar keeps its height while it asks",
      Math.abs(rect(firstBar()).height - cssPx("var(--hh-bar-h)")) <= 0.5,
    );
    await userEvent.click(cancel);
    await panelTo(46 * 16 - 1);
    expectPass(
      "narrow households: narrow just below the line",
      document.querySelector("[data-head-strip]") === null,
    );
    const menu = within(firstBar() as HTMLElement).getByRole("button", { name: /^Actions for / });
    expectPass("narrow households: the menu is reachable", reachable(menu));
    // Back across the line by a pixel is not enough: a rem of room first.
    await panelTo(46 * 16 + 1);
    expectPass(
      "narrow households: stays narrow a pixel above",
      document.querySelector("[data-head-strip]") === null,
    );
    await panelTo(47 * 16 + 1);
    expectPass(
      "narrow households: wide again a rem above",
      document.querySelector("[data-head-strip]") !== null,
    );
  });

  it("draws the RSVP table down to 45rem for an editor, every button on screen", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "rsvps" });
    await loaded("rsvps");
    await panelTo(45 * 16 + 1);
    expectPass("narrow rsvps: wide just above the line", document.querySelector("table") !== null);
    const buttons = [...document.querySelectorAll<HTMLElement>("tbody button")].filter(
      (b) => rect(b).bottom > rect(viewBar()).bottom && rect(b).bottom < innerHeight,
    );
    expectPass(
      "narrow rsvps: every reply button on screen is reachable",
      buttons.length > 0 && buttons.every(reachable),
    );
    await panelTo(45 * 16 - 1);
    expectPass(
      "narrow rsvps: stacked just below the line",
      document.querySelector("table") === null,
    );
  });
});

// ── Other modules ────────────────────────────────────────────────────────────
describe("the invite builder under the stack", () => {
  const sectionTabs = () =>
    screen.getByRole("navigation", { name: "Invite sections" }).parentElement!;

  // A short window: an empty builder is not much taller than a laptop's.
  it("holds its section tabs under the view bar, never behind it", async () => {
    await page.viewport(1280, 400);
    render({ module: "invite", sub: "design" }, { customisation: EMPTY_CUSTOMISATION });
    await vi.waitFor(() => screen.getByText("Save invite"), { timeout: 10_000 });
    await frames();
    window.scrollTo(0, 2000);
    await frames();
    expectPass(
      "invite: the bar holds under the top bar",
      Math.abs(rect(viewBar()).top - rect(topBar()).bottom) <= 1,
    );
    expectPass(
      "invite: the section tabs hold under the bar",
      Math.abs(rect(sectionTabs()).top - rect(viewBar()).bottom) <= 1,
    );
    expectPass("invite: the section tabs are painted", onTop(sectionTabs().querySelector("nav")!));
    await screenshotWindow("invite-1280-scrolled");
  });

  it("holds them under the top bar where a co-host's module has no bar", async () => {
    await page.viewport(1280, 400);
    // An editor co-host sees Design alone, so the module draws no bar.
    render(
      { module: "invite", sub: "design", canManage: false },
      { customisation: EMPTY_CUSTOMISATION },
    );
    await vi.waitFor(() => screen.getByText("Save invite"), { timeout: 10_000 });
    await frames();
    expectPass("invite co-host: no view bar", document.querySelector("[data-view-bar]") === null);
    window.scrollTo(0, 2000);
    await frames();
    expectPass(
      "invite co-host: the section tabs hold under the top bar",
      Math.abs(rect(sectionTabs()).top - rect(topBar()).bottom) <= 1,
    );
  });

  it("leaves no --bar-h behind on a move to a module with no bar", async () => {
    await page.viewport(1280, 400);
    const view = render(
      { module: "guests", sub: "list", canManage: false },
      { ...FULL, customisation: EMPTY_CUSTOMISATION },
    );
    await loaded("list");
    const shell = viewBar().closest<HTMLElement>(".\\@container\\/shell")!;
    expectPass(
      "bar-h gone: set while Guests has its bar",
      shell.style.getPropertyValue("--bar-h") !== "",
    );
    view.setModule("invite");
    view.setSub("design");
    await vi.waitFor(() => screen.getByText("Save invite"), { timeout: 10_000 });
    await frames();
    expectPass(
      "bar-h gone: Invite draws no bar",
      document.querySelector("[data-view-bar]") === null,
    );
    expectPass(
      "bar-h gone: the property is removed",
      shell.style.getPropertyValue("--bar-h") === "",
    );
    window.scrollTo(0, 2000);
    await frames();
    expectPass(
      "bar-h gone: the section tabs hold at the top bar's foot",
      Math.abs(rect(sectionTabs()).top - rect(topBar()).bottom) <= 1,
    );
  });
});

// ── What the stuck layers cost ───────────────────────────────────────────────
/**
 * Layout and style time over a scripted scroll through the 300 households,
 * with the stuck layers and with them forced static. Read from Chrome's own
 * counters (`Performance.getMetrics`), which a headless run still keeps. The
 * numbers vary by machine, so they are printed and written beside the results,
 * not asserted; `NEW-FEAT.md` and the pull request carry what was measured.
 * A measurement, not a test, so it runs only when asked:
 * `VITE_GUESTS_STACK_BENCH=1 bun run --cwd cire/host test:browser
 * tests/components/GuestsStack.browser.test.tsx`.
 */
describe.runIf(import.meta.env.VITE_GUESTS_STACK_BENCH === "1")("the stuck layers' cost", () => {
  it("records layout and style time over a scroll, stuck and unstuck", async () => {
    await page.viewport(1280, 800);
    render({ module: "guests", sub: "list" });
    await loaded("list");
    const session = cdp();
    await session.send("Performance.enable");
    const metric = async () => {
      const { metrics } = (await session.send("Performance.getMetrics")) as {
        metrics: { name: string; value: number }[];
      };
      const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
      return get("LayoutDuration") + get("RecalcStyleDuration");
    };
    const run = async () => {
      window.scrollTo(0, 0);
      await frames();
      const start = await metric();
      const end = document.documentElement.scrollHeight - innerHeight;
      for (let y = 0; y <= end; y += 400) {
        window.scrollTo(0, y);
        await frames(1);
      }
      return (await metric()) - start;
    };
    await run(); // warm-up
    const stuck: number[] = [];
    const unstuck: number[] = [];
    const style = document.createElement("style");
    style.dataset.unstick = "";
    style.textContent =
      "[data-view-bar], [data-head-strip], [data-household-bar] { position: static !important; }";
    for (let round = 0; round < 3; round += 1) {
      stuck.push(await run());
      document.head.append(style);
      unstuck.push(await run());
      style.remove();
    }
    const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[1]!;
    const cost = {
      stuckMs: Math.round(median(stuck) * 1000 * 10) / 10,
      unstuckMs: Math.round(median(unstuck) * 1000 * 10) / 10,
      ratio: Math.round((median(stuck) / median(unstuck)) * 100) / 100,
      steps: Math.ceil((document.documentElement.scrollHeight - innerHeight) / 400),
    };
    // oxlint-disable-next-line no-console -- the measurement is this test's output.
    console.log(`STICKY-COST ${JSON.stringify(cost)}`);
    await commands.writeFile(
      ".vitest/guests-stack/sticky-cost.json",
      `${JSON.stringify(cost, null, 2)}\n`,
    );
    expect(cost.steps).toBeGreaterThan(100);
  }, 180_000);
});
