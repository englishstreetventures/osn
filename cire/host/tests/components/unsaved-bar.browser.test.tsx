import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The events and guests editors' unsaved-changes bar, measured in Chromium. It
 * is fixed to the window's foot and mounts on the first edit of a run; it
 * rises from that edge by its own height (`bar-rise`, `@starting-style`) and
 * leaves at once, since it holds Save and Discard. Only an engine computes a
 * `@starting-style` from-state and a running transition, so only this tier can
 * see the rise; `GuestsEditor.test.tsx` holds when the bar is there at all.
 *
 * One case per way it can fail (NEW-FEAT.md failure list): it appears at rest
 * on its first frame; it rises but never reaches rest; it lingers or moves on
 * the way out; it moves under reduced motion; a control focused near the
 * window's foot ends under it (WCAG 2.4.11), which only an engine's own
 * scroll-into-view can show.
 *
 * Screenshots go to `e2e-artifacts/cire-host/unsaved-bar/`.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
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

import EventsEditor from "../../src/components/EventsEditor";
import GuestsEditor from "../../src/components/GuestsEditor";
import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";

const EVENT = {
  id: "evt_1",
  name: "Ceremony",
  slug: "ceremony",
  sortOrder: 0,
  startAt: "2026-11-14T15:00:00+11:00",
  endAt: "2026-11-14T16:00:00+11:00",
  timezone: "Australia/Sydney",
  venueName: "The Glasshouse",
  address: "124 Sample Avenue, Exampleville NSW 2001",
  description: "",
  runOfShow: [],
  gettingThere: null,
  childrenPolicy: "adults_only",
  plusOnePolicy: "welcome",
  guestPolicyNote: null,
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  imageUrl: null,
  imageCrop: null,
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Eight events, enough to run the events editor past a phone's window. */
const EIGHT_EVENTS = Array.from({ length: 8 }, (_, i) => ({
  ...EVENT,
  id: `evt_${i + 1}`,
  name: `Event ${i + 1}`,
  slug: `event-${i + 1}`,
  sortOrder: i,
}));

/**
 * Each editor, loaded; the control whose press makes its first edit; and how
 * to make it long enough to scroll and leave it with unsaved changes and no
 * drawer open.
 */
const EDITORS = [
  {
    name: "the events editor",
    slug: "events",
    mount: () => render(() => <EventsEditor weddingId="wed_1" />),
    edit: "Add event",
    async makeLongAndDirty() {
      routeLoads(EIGHT_EVENTS);
      render(() => <EventsEditor weddingId="wed_1" />);
      (await editControl("Add event")).click();
      // Adding an event opens its drawer; closing it keeps the new event.
      (await screen.findByRole("button", { name: "Close" })).click();
      await vi.waitFor(() => {
        if (screen.queryByRole("dialog")) throw new Error("the drawer is still open");
      });
    },
  },
  {
    name: "the guests editor",
    slug: "guests",
    mount: () => render(() => <GuestsEditor weddingId="wed_1" />),
    edit: "Add household",
    async makeLongAndDirty() {
      routeLoads();
      render(() => <GuestsEditor weddingId="wed_1" />);
      for (let i = 0; i < 6; i++) (await editControl("Add household")).click();
    },
  },
] as const;

function routeLoads(events: readonly (typeof EVENT)[] = [EVENT]) {
  authFetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/changes/head")) return json({ revision: "rev_1" });
    if (u.endsWith("/events")) return json(events);
    if (u.endsWith("/guests")) return json([]);
    if (u.endsWith("/households")) return json([]);
    return json({});
  });
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

const SHOTS = "../../../../e2e-artifacts/cire-host/unsaved-bar";

/** What the browser can move focus to, as the invite builder's save bar counts it. */
const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select, textarea, a[href], [tabindex]:not([tabindex='-1'])";

/** Discard, which the bar always holds. `hidden`, since the events editor's
 *  drawer, open over it, makes the page behind it inert. */
const discard = () => screen.queryByRole("button", { name: "Discard changes", hidden: true });

/** The bar: the fixed box round its Discard button. */
function findBar(): HTMLElement {
  for (let el: HTMLElement | null = discard(); el; el = el.parentElement) {
    if (getComputedStyle(el).position === "fixed") return el;
  }
  throw new Error("no fixed bar round Discard changes");
}

/** The control whose press makes the editor's first edit. The guests editor
 *  offers Add household twice while it has none: in its bar and its empty state. */
async function editControl(name: string) {
  const [first] = await screen.findAllByRole("button", { name });
  return first!;
}

/** How far the bar sits below its resting place, which is flush with the window's foot. */
const drop = (bar: HTMLElement) => bar.getBoundingClientRect().bottom - window.innerHeight;

/** Frames read once the bar's transition has ended, to see it stay at rest. */
const AFTER_END = 6;

/** Frames past which a transition that has not ended fails the case. */
const MOST_FRAMES = 600;

/**
 * Presses `edit` with a synchronous click, so the bar mounts in this task, and
 * reads the bar's drop on each frame from the first one painted with it, until
 * the engine reports no transition running on the bar and `AFTER_END` frames
 * more. Read in `requestAnimationFrame`, so each value is the one that frame
 * paints. The end is the engine's own, not a span of wall time, so a loaded
 * machine that draws fewer frames still reads the whole transition.
 *
 * `ended` is the first frame read with no transition running. `span` is the
 * longest time, delay included, that a transition on the bar takes, in ms.
 */
async function editAndWatch(edit: HTMLElement) {
  edit.click();
  const el = findBar();
  const height = el.getBoundingClientRect().height;
  const span = Math.max(
    0,
    ...el.getAnimations().map((a) => Number(a.effect?.getComputedTiming().endTime)),
  );
  const drops: number[] = [];
  let ended = -1;
  while (ended < 0 || drops.length < ended + AFTER_END) {
    if (drops.length >= MOST_FRAMES) throw new Error("the bar's transition never ended");
    await nextFrame();
    if (ended < 0 && el.getAnimations().length === 0) ended = drops.length;
    drops.push(drop(el));
  }
  return { bar: el, height, drops, ended, span };
}

/** Slows the portal threefold, so a rise spans enough frames to read. */
function slowMotion() {
  const root = document.documentElement.style;
  root.setProperty("--motion-scale", "3");
  onTestFinished(() => {
    root.removeProperty("--motion-scale");
  });
}

afterEach(async () => {
  cleanup();
  window.scrollTo(0, 0);
  __resetEventsCache();
  __resetGuestsCache();
  __resetHouseholdsCache();
  authFetch.mockReset();
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe.each(EDITORS)("the unsaved-changes bar in $name", (editor) => {
  it("rises from the window's foot by its own height, and comes to rest", async () => {
    slowMotion();
    await page.viewport(1280, 800);
    routeLoads();
    editor.mount();
    const edit = await editControl(editor.edit);

    const { bar, height, drops } = await editAndWatch(edit);
    expect(height).toBeGreaterThan(30);
    // Drawn first below its place, by no more than its own height.
    expect(drops[0]).toBeGreaterThan(height / 2);
    expect(drops[0]).toBeLessThanOrEqual(height + 0.5);
    // It passes through places between, on several frames, and never sinks.
    expect(drops.filter((d) => d > 1 && d < height - 1).length).toBeGreaterThan(2);
    for (let i = 1; i < drops.length; i++) {
      expect(drops[i]).toBeLessThanOrEqual(drops[i - 1]! + 0.5);
    }
    // And rests flush with the foot, with nothing left on it.
    expect(drops.at(-1)).toBeCloseTo(0, 0);
    expect(getComputedStyle(bar).translate).toBe("none");
  });

  it("goes at once when the edits are discarded", async () => {
    await page.viewport(1280, 800);
    routeLoads();
    editor.mount();
    const edit = await editControl(editor.edit);
    edit.click();
    const shown = findBar();

    discard()!.click();
    expect(shown.isConnected).toBe(false);
    await nextFrame();
    expect(discard()).toBeNull();
  });

  it("comes to rest under reduced motion on no frame partway", async () => {
    slowMotion();
    await commands.emulateMedia({ reducedMotion: "reduce" });
    await page.viewport(390, 844);
    routeLoads();
    editor.mount();
    const edit = await editControl(editor.edit);

    const { height, drops, ended, span } = await editAndWatch(edit);
    expect(drops.filter((d) => d > 1 && d < height - 1)).toEqual([]);
    // The switch gives the rise no time of its own, delay included.
    expect(span).toBeLessThan(1);
    // The engine may paint its start until it ends the switch's 0.01ms, on as
    // many frames as a loaded machine takes to get there. It is at rest by the
    // first frame after, and from the first frame at rest, it stays there.
    const rest = drops.findIndex((d) => Math.abs(d) < 0.5);
    expect(rest).toBeGreaterThanOrEqual(0);
    expect(rest).toBeLessThanOrEqual(ended);
    for (const d of drops.slice(rest)) expect(d).toBeCloseTo(0, 0);
  });

  it("keeps a control Tab reaches at the window's foot above it, on a phone", async () => {
    await page.viewport(390, 844);
    await editor.makeLongAndDirty();
    const bar = findBar();
    await Promise.all(bar.getAnimations().map((a) => a.finished));

    // The first of the editor's controls below the first screen, scrolled to
    // sit inside the window but behind the bar: a browser counts that as in
    // view and scrolls nowhere for it unless its scroll margin says otherwise.
    window.scrollTo(0, 0);
    await nextFrame();
    const controls = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !bar.contains(el) && el.checkVisibility(),
    );
    const at = controls.findIndex((el) => el.getBoundingClientRect().top > window.innerHeight);
    expect(at).toBeGreaterThan(0);
    const target = controls[at]!;
    window.scrollTo(
      0,
      window.scrollY + target.getBoundingClientRect().bottom - (window.innerHeight - 10),
    );
    await nextFrame();
    expect(target.getBoundingClientRect().bottom).toBeGreaterThan(bar.getBoundingClientRect().top);

    controls[at - 1]!.focus({ preventScroll: true });
    await userEvent.tab();
    await nextFrame();
    await nextFrame();
    expect(document.activeElement).toBe(target);
    const barBox = bar.getBoundingClientRect();
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(barBox.top + 0.5);
    // By the room the bar's measured height asks for.
    expect(parseFloat(getComputedStyle(target).scrollMarginBottom)).toBeCloseTo(
      barBox.height + 8,
      1,
    );
    await page.screenshot({ path: `${SHOTS}/${editor.slug}-tab-at-foot-390.png` });
  });
});
