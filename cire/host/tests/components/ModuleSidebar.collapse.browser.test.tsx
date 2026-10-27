import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The module rail collapsed to its icons, in a real engine.
 *
 * The end-to-end flow proves the toggle, the stored choice across a reload and
 * a locked row's card on the collapsed rail. What only a stylesheet, a layout
 * engine and Chrome's accessibility tree can answer is here:
 *
 * - where a collapsed row's label appears, that it paints on top of the panel
 *   and the top bar, and that its ink reads in both themes;
 * - that a collapsed row is named by its label and described by its hint once,
 *   with the label's panel open or closed, and that the toggle has no
 *   description to repeat its name;
 * - that a locked row's card and the labels never sit on top of one another,
 *   and that a resting pointer opens no card on the collapsed rail;
 * - that a phone, where the sheet stands in for the rail, ignores the choice;
 * - that a reader who asked for no motion gets the narrow rail at once;
 * - that the sticky rail stays below the sticky top bar once the page scrolls;
 * - what the slide costs, frame by frame, over a wedding-sized RSVP table.
 *
 * It renders the real `ModuleShell` on Guests → RSVPs for a Gold wedding, so
 * Vendors is the one locked row, under a stand-in for the page's sticky top bar
 * with the same classes and heights. Screenshots land in `__screenshots__/`
 * beside this file (gitignored).
 *
 * The browser context, and so `localStorage`, is shared by every browser test
 * file in a run: the stored choice is cleared before and after each test here,
 * or a collapsed rail would leak into the other rail suites.
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
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => ({ markSeq: 0, rows: [] }),
  markRsvpChangesSeen: async () => {},
}));

import ModuleShell from "../../src/components/ModuleShell";
import { RAIL_PREFERENCE_KEY } from "../../src/lib/rail-preference";
import { eventPayload, guestList } from "../test-support/rsvp-guests";

/** The rail's two widths: 14rem at this shell width, and the row's own padding
 *  around the 1.125rem icon. */
const EXPANDED = 224;
const COLLAPSED = 42;

/** Beside this file, in the gitignored `__screenshots__/`. */
const shot = (name: string) =>
  `__screenshots__/ModuleSidebar.collapse.browser.test.tsx/${name}.png`;

/** The page around the shell: the frame container, a sticky top bar with the
 *  real one's classes and the page measure — and, when `tall`, enough below
 *  the shell to scroll it under the bar. */
function renderPage(guests = 12, tall = false) {
  const payload = { events: [eventPayload("evt_ceremony", "Ceremony", guestList(guests), 0)] };
  authFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const rows = payload.events[0]!.guests.length + payload.events[0]!.unresponded.length;
  render(() => (
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
          canEdit
          module="guests"
          sub="rsvps"
          onModule={() => {}}
          onSub={() => {}}
          rsvpEvent={undefined}
          onRsvpEvent={() => {}}
          tier="gold"
          entitlements={[]}
          guestCap={1000}
        />
      </main>
      {tall ? <div style={{ height: "2000px" }} /> : null}
    </div>
  ));
  return rows;
}

async function ready(rows: number) {
  await vi.waitFor(() => expect(document.querySelectorAll("tbody > tr")).toHaveLength(rows), {
    timeout: 5_000,
  });
  await document.fonts.ready;
}

const rail = () => document.querySelector<HTMLElement>("[data-rail]")!;
const nav = () => screen.getByRole("navigation", { name: "Wedding modules" });
const toggle = () => screen.getByRole("button", { name: /^(Collapse|Expand) sidebar$/ });
const row = (name: string | RegExp) => within(nav()).getByRole("button", { name });
const vendors = () => row(/^Vendors — locked/);
const heading = () => screen.getByRole("heading", { level: 2, name: "Guests" });
const topBar = () => document.querySelector<HTMLElement>("[data-top-bar]")!;
const upgrade = () => screen.queryByRole("button", { name: "Upgrade to Crimson" });
/** The open label, if any. It is `aria-hidden`, so a role query skips it. */
const tip = () => document.querySelector<HTMLElement>("[data-rail-tip]");
const width = (el: Element) => el.getBoundingClientRect().width;
/** Where every icon on the rail sits, the toggle's last. */
const marks = () =>
  [...rail().querySelectorAll("svg")].map((svg) => {
    const { left, top } = svg.getBoundingClientRect();
    return [left, top];
  });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Press the toggle and wait for the rail to settle at `to`. */
async function slide(to: number) {
  await userEvent.click(toggle());
  await expect.poll(() => width(rail())).toBe(to);
}

/** Wait for a label to open, and for its entrance to finish. */
async function openTip(): Promise<HTMLElement> {
  const found = await vi.waitFor(
    () => {
      const el = tip();
      if (!el) throw new Error("no rail label open");
      return el;
    },
    { timeout: 3000 },
  );
  await Promise.all(found.getAnimations().map((animation) => animation.finished));
  return found;
}

/** Composite `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** A line's ink against every background under it, as the screen shows them. */
function ratio(line: Element): number {
  const layers: string[] = [];
  for (let node: Element | null = line; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.push(bg);
  }
  const backdrop = composite(layers.toReversed());
  return contrastRatio(composite([backdrop, getComputedStyle(line).color]), backdrop)!;
}

/** Whether the element painted at a box's centre is that box or inside it. */
function expectOnTop(el: Element, what: string) {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const found = hit ? `<${hit.tagName.toLowerCase()}> "${hit.textContent?.trim()}"` : "nothing";
  expect(hit !== null && el.contains(hit), `${what} is covered by ${found}`).toBe(true);
}

interface AXNode {
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
}

interface Frame {
  frame: { id: string; url: string };
  childFrames?: Frame[];
}

/** Chrome's accessibility tree for the frame this test runs in, ignored nodes included. */
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

/**
 * Chrome carries `text-transform` into the names it computes, and the rail's
 * rows are `uppercase`, so a row is named "OVERVIEW" in the tree. Names are
 * compared without case: what these tests ask is which words, and how often.
 */
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/** The one button Chrome exposes under `name`: its description, `""` for none. */
async function describedAs(name: string): Promise<string> {
  const buttons = (await accessibilityTree()).filter(
    (node) => !node.ignored && node.role?.value === "button" && same(node.name?.value, name),
  );
  expect(buttons, `buttons named ${JSON.stringify(name)}`).toHaveLength(1);
  return buttons[0]!.description?.value ?? "";
}

/** How many times Chrome hands a screen reader `text` as text it reaches. */
async function readOut(text: string): Promise<number> {
  return (await accessibilityTree()).filter(
    (node) => !node.ignored && node.role?.value === "StaticText" && same(node.name?.value, text),
  ).length;
}

beforeEach(() => {
  localStorage.removeItem(RAIL_PREFERENCE_KEY);
});

afterEach(async () => {
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  cleanup();
  authFetch.mockReset();
  delete document.documentElement.dataset.theme;
  window.scrollTo(0, 0);
  localStorage.removeItem(RAIL_PREFERENCE_KEY);
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("the collapsed rail at desktop width", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`shows a row's label beside it, on top, readable, in the ${theme} theme`, async () => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(1280, 800);
      await ready(renderPage());
      expect(width(rail())).toBe(EXPANDED);
      await page.screenshot({ path: shot(`${theme}-1280-expanded`) });
      const before = marks();

      await slide(COLLAPSED);
      // Every icon and the toggle stayed exactly where they were: the row's
      // padding is the rail's width, and a row keeps its height without its
      // label, so a second click lands on the toggle again.
      expect(width(nav())).toBe(COLLAPSED);
      expect(marks()).toEqual(before);
      // The toggle's own label may have opened under the resting pointer; it
      // goes once the pointer leaves.
      await userEvent.hover(heading());
      await vi.waitFor(() => expect(tip()).toBeNull());
      await page.screenshot({ path: shot(`${theme}-1280-collapsed`) });

      const overview = row("Overview");
      await userEvent.hover(overview);
      const label = await openTip();
      expect(label.textContent).toBe("OverviewYour wedding at a glance");
      const at = label.getBoundingClientRect();
      const from = overview.getBoundingClientRect();
      expect(at.left - rail().getBoundingClientRect().right).toBeCloseTo(8, 0);
      expect(Math.abs(at.top + at.height / 2 - (from.top + from.height / 2))).toBeLessThanOrEqual(
        1,
      );
      expectOnTop(label, "the Overview label");
      for (const line of label.querySelectorAll("span")) {
        const measured = ratio(line);
        expect(
          measured,
          `"${line.textContent}" measured ${measured.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
      }
      await page.screenshot({ path: shot(`${theme}-1280-collapsed-tooltip`) });

      // A locked row's label names the tier, in gold ink that has to read too.
      await userEvent.hover(vendors());
      await vi.waitFor(() => expect(tip()?.textContent).toBe("VendorsIncluded with Crimson"));
      const tier = tip()!.querySelectorAll("span")[1]!;
      const measured = ratio(tier);
      expect(measured, `tier line measured ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        WCAG_TEXT_MIN,
      );
      expectOnTop(tip()!, "the Vendors label");
    });
  }

  it("names a collapsed row by its label and describes it by its hint, once", async () => {
    await page.viewport(1280, 800);
    await ready(renderPage());

    // Expanded, the hint is the row's native tooltip, and so its description.
    expect(await describedAs("Overview")).toBe("Your wedding at a glance");
    expect(await describedAs("Collapse sidebar")).toBe("");

    await slide(COLLAPSED);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(toggle().getAttribute("aria-controls")!)).toBe(nav());
    expect(row("Overview").hasAttribute("title")).toBe(false);
    expect(await describedAs("Overview")).toBe("Your wedding at a glance");
    expect(await describedAs("Expand sidebar")).toBe("");

    // With the label open, nothing changes for a screen reader: the panel is
    // for the eye only, and the row points at its own hint, not at it.
    await userEvent.hover(row("Overview"));
    await openTip();
    expect(await describedAs("Overview")).toBe("Your wedding at a glance");
    expect(await readOut("Your wedding at a glance")).toBe(0);
    expect(await readOut("Overview")).toBe(1);

    await userEvent.hover(vendors());
    await vi.waitFor(() => expect(tip()?.textContent).toContain("Vendors"));
    expect(await describedAs("Vendors — locked. Included with Crimson.")).toBe("");

    await userEvent.hover(toggle());
    await vi.waitFor(() => expect(tip()?.textContent).toBe("Expand sidebar"));
    expect(await describedAs("Expand sidebar")).toBe("");
  });

  it("keeps the labels off a locked row's card, and opens no card on a resting pointer", async () => {
    await page.viewport(1280, 800);
    await ready(renderPage());
    await slide(COLLAPSED);
    await userEvent.hover(heading());
    await vi.waitFor(() => expect(tip()).toBeNull());

    // A pointer that arrives and presses at once: the label's open delay is
    // still running when the card opens, and runs out with the card open.
    await userEvent.click(vendors());
    await vi.waitFor(() => expect(upgrade()).not.toBeNull());
    await pause(700);
    expect(tip()).toBeNull();

    // No other row's label opens while the card is open.
    await userEvent.hover(row("Overview"));
    await pause(700);
    expect(tip()).toBeNull();
    expect(upgrade()).not.toBeNull();

    // Closed by a click away, with the pointer off the rail: no label comes
    // back, not even the one whose delay ran out while the card was open.
    await userEvent.click(heading());
    await vi.waitFor(() => expect(upgrade()).toBeNull());
    await pause(700);
    expect(tip()).toBeNull();

    // A label already showing goes when a press swaps it for the card.
    await userEvent.hover(vendors());
    await openTip();
    await userEvent.click(vendors());
    await vi.waitFor(() => expect(upgrade()).not.toBeNull());
    expect(tip()).toBeNull();

    // Pressed again, the card closes. A pointer resting on the row past the
    // expanded rail's three-second dwell opens nothing more: collapsed, the
    // label names the lock and the card waits for a press.
    await userEvent.click(vendors());
    await vi.waitFor(() => expect(upgrade()).toBeNull());
    await pause(3_400);
    expect(upgrade()).toBeNull();

    // From the keyboard, Escape hands focus back to the row, and focus shows
    // the row's label again.
    vendors().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(document.activeElement).toBe(upgrade()));
    expect(tip()).toBeNull();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(vendors()));
    await vi.waitFor(() => expect(tip()?.textContent).toBe("VendorsIncluded with Crimson"));
  });

  it("goes straight to the narrow rail for a reader who asked for no motion", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    await page.viewport(1280, 800);
    await ready(renderPage());
    toggle().click();
    // The style change is where a transition starts, at its first value, and
    // Chrome fixes its start time when the next frame commits. Four frames on,
    // a 0.01ms transition has ended; a 200ms one is barely a sixth of the way.
    expect(width(rail())).toBe(EXPANDED);
    for (let i = 0; i < 4 && width(rail()) !== COLLAPSED; i++) await nextFrame();
    expect(width(rail())).toBe(COLLAPSED);
    expect(rail().getAnimations()).toHaveLength(0);
  });

  it("keeps the sticky rail below the sticky top bar once the page scrolls", async () => {
    await page.viewport(1280, 800);
    await ready(renderPage(12, true));
    // Far enough that the rail's own place in the page has gone under the bar.
    window.scrollBy(0, rail().getBoundingClientRect().top - 10);
    await nextFrame();
    expect(rail().getBoundingClientRect().top).toBeGreaterThanOrEqual(
      topBar().getBoundingClientRect().bottom,
    );
    expectOnTop(toggle(), "the toggle, after scrolling");
  });

  it("slides, frame by frame, over a 300-guest table", async ({ annotate }) => {
    await page.viewport(1280, 800);
    await ready(renderPage(300));

    /** Frame deltas and rail widths from a press until the rail settles. */
    async function record(to: number) {
      const deltas: number[] = [];
      const widths: number[] = [];
      toggle().click();
      let last = performance.now();
      for (let i = 0; i < 60 && widths.at(-1) !== to; i++) {
        await nextFrame();
        const now = performance.now();
        deltas.push(now - last);
        last = now;
        widths.push(width(rail()));
      }
      return { deltas, widths };
    }
    const summary = (label: string, { deltas }: { deltas: number[] }) => {
      const sorted = deltas.toSorted((a, b) => a - b);
      return `${label}: ${deltas.length} frames, longest ${sorted.at(-1)!.toFixed(1)}ms, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)}ms`;
    };

    const collapse = await record(COLLAPSED);
    await userEvent.hover(heading());
    const expand = await record(EXPANDED);
    await annotate(`${summary("collapse", collapse)}; ${summary("expand", expand)}`);

    // It moved between the two widths rather than jumping, and it landed.
    for (const run of [collapse, expand]) {
      expect(run.widths.some((w) => w > COLLAPSED + 1 && w < EXPANDED - 1)).toBe(true);
    }
    expect(collapse.widths.at(-1)).toBe(COLLAPSED);
    expect(expand.widths.at(-1)).toBe(EXPANDED);
  });
});

describe("on a phone", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`ignores a stored collapsed rail: the sheet shows every label, ${theme}`, async () => {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem(RAIL_PREFERENCE_KEY, "collapsed");
      await page.viewport(390, 844);
      await ready(renderPage());
      expect(screen.queryByRole("button", { name: /sidebar$/ })).toBeNull();
      await page.screenshot({ path: shot(`${theme}-390-closed`) });

      await userEvent.click(screen.getByRole("button", { name: /Open wedding navigation/ }));
      const sheet = await vi.waitFor(() => screen.getByRole("dialog", { name: "Wedding modules" }));
      await Promise.all(sheet.getAnimations().map((animation) => animation.finished));
      for (const label of ["Overview", "Guests", "Settings"]) {
        expect(width(within(sheet).getByText(label))).toBeGreaterThan(20);
      }
      await page.screenshot({ path: shot(`${theme}-390-sheet`) });
    });
  }
});
