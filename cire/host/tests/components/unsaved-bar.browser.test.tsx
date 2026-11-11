import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { commands, page } from "vitest/browser";

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
 * the way out; it moves under reduced motion.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
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

/** Each editor, loaded, and the control whose press makes its first edit. */
const EDITORS = [
  {
    name: "the events editor",
    mount: () => render(() => <EventsEditor weddingId="wed_1" />),
    edit: "Add event",
  },
  {
    name: "the guests editor",
    mount: () => render(() => <GuestsEditor weddingId="wed_1" />),
    edit: "Add household",
  },
] as const;

function routeLoads() {
  authFetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/changes/head")) return json({ revision: "rev_1" });
    if (u.endsWith("/events")) return json([EVENT]);
    if (u.endsWith("/guests")) return json([]);
    if (u.endsWith("/households")) return json([]);
    return json({});
  });
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

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

/**
 * Presses `edit` with a synchronous click, so the bar mounts in this task, and
 * reads the bar's drop on each frame from the first one painted with it, until
 * its transition has run and a few frames more. Read in `requestAnimationFrame`,
 * so each value is the one that frame paints.
 */
async function editAndWatch(edit: HTMLElement) {
  edit.click();
  const el = findBar();
  const height = el.getBoundingClientRect().height;
  const longest = Math.max(
    ...getComputedStyle(el)
      .transitionDuration.split(",")
      .map((s) => Number.parseFloat(s)),
  );
  const drops: number[] = [];
  const until = performance.now() + longest * 1000 + 100;
  while (performance.now() < until) {
    await nextFrame();
    drops.push(drop(el));
  }
  return { bar: el, height, drops };
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

  it("is at rest at once under reduced motion, on no frame partway", async () => {
    slowMotion();
    await commands.emulateMedia({ reducedMotion: "reduce" });
    await page.viewport(390, 844);
    routeLoads();
    editor.mount();
    const edit = await editControl(editor.edit);

    const { height, drops } = await editAndWatch(edit);
    expect(drops.filter((d) => d > 1 && d < height - 1)).toEqual([]);
    for (const d of drops.slice(1)) expect(d).toBeCloseTo(0, 0);
  });
});
