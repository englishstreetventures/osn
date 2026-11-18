import Disclosure from "@cire/ui/disclosure";
import { AUTO_SIZE_CAP, createAutoSize } from "@cire/ui/lib/auto-size";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, type JSX, Show } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A `Disclosure` growing open inside the module panel's frame, the box
 * `createAutoSize()` sizes in `ModuleShell`. Both animate a height: the
 * disclosure its body slot, the frame itself when the content under it
 * changes. While the panel's content is under `AUTO_SIZE_CAP` at both ends
 * of a change, each frame of the growth is such a change; a frame that
 * animated it would trail the growth with `overflow: hidden` and cut the
 * panel's foot until it caught up. The frame follows the growth instead.
 *
 * Every frame of an opening is read: the bottom of the measured content
 * against the bottom of the frame that clips it, and once it ends, the
 * frame's inline height, `overflow` and `contain`, which must all be gone.
 *
 * The seating screen's "Arrange tables" is read in the real `ModuleShell`. At
 * this fixture (two tables, no guests) its panel is over the cap at both
 * viewports, so the frame lets the change through untouched; the short panel
 * below, built as `ModuleShell` builds its frame, is the case under the cap.
 * The real panel's picture at rest goes to `__screenshots__/` beside this
 * file (gitignored).
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

import { __resetEventsCache } from "../../src/lib/events-store";
import { renderOrganiserPage } from "../test-support/organiser-page";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const nextFrame = () => new Promise<number>((done) => requestAnimationFrame(done));

const VIEWPORTS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

const EVENT = {
  id: "e_rec",
  name: "Reception",
  slug: "reception",
  sortOrder: 0,
  startAt: "2027-03-01T18:00",
  endAt: "",
  timezone: "UTC",
  address: null,
  description: "",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  imageUrl: null,
  imageCrop: null,
};

/** Two tables, the fewest that show "Arrange tables", and no guests. */
const CHART = {
  event: { id: "e_rec", name: "Reception" },
  tables: [
    { id: "t1", name: "Table 1", capacity: 8, sortOrder: 0 },
    { id: "t2", name: "Table 2", capacity: 8, sortOrder: 1 },
  ],
  guests: [],
};

/** Slows the portal threefold, so an opening spans enough frames to read. */
function slowMotion() {
  const root = document.documentElement.style;
  root.setProperty("--motion-scale", "3");
  onTestFinished(() => {
    root.removeProperty("--motion-scale");
  });
}

/**
 * How long, in ms, an opening and the frame's longest move after it can run:
 * `--dur-slow` and `--dur-base` as the stylesheet resolves them now, plus a
 * few frames to settle.
 */
function settleMs(): number {
  const probe = document.createElement("span");
  document.body.append(probe);
  const ms = (token: string) => {
    probe.style.transitionDuration = `var(${token})`;
    return Number.parseFloat(getComputedStyle(probe).transitionDuration) * 1000;
  };
  const total = ms("--dur-slow") + ms("--dur-base") + 100;
  probe.remove();
  return total;
}

/** One painted frame: how far the content runs past the frame, and the box watched. */
interface Frame {
  /** The content's bottom less the frame's, in px: above 0 is cut off. */
  over: number;
  box: number;
  inlineHeight: string;
}

/** Read every frame until `stop()`. */
function sampleFrames(frame: HTMLElement, content: HTMLElement, box: () => Element) {
  const frames: Frame[] = [];
  let running = true;
  const read = () => {
    if (!running) return;
    frames.push({
      over: content.getBoundingClientRect().bottom - frame.getBoundingClientRect().bottom,
      box: box().getBoundingClientRect().height,
      inlineHeight: frame.style.height,
    });
    requestAnimationFrame(read);
  };
  requestAnimationFrame(read);
  return {
    frames,
    stop: () => {
      running = false;
    },
  };
}

/** Wait out an opening or a move, and whatever the frame runs after it. */
async function settle(): Promise<void> {
  const until = performance.now() + settleMs();
  while (performance.now() < until) await nextFrame();
}

/** What the frame holds once it has handed its height back: nothing. */
const held = (frame: HTMLElement) => [
  frame.style.height,
  frame.style.overflow,
  frame.style.contain,
];

/** Three lines of body, made fresh for each disclosure that shows them. */
const lines = () => (
  <>
    <p>Drag a table to move it.</p>
    <p>Tables keep their order on the printed plan.</p>
    <p>A table's number follows its place in the list.</p>
  </>
);

/** A panel frame as `ModuleShell` builds it: the hook's frame, a measured `flow-root` inside. */
function Framed(props: { onFrame: (el: HTMLElement) => void; children: JSX.Element }) {
  const size = createAutoSize();
  return (
    <div
      ref={(el) => {
        props.onFrame(el);
        size.frame(el);
      }}
      style={{ width: "360px" }}
    >
      <div ref={size.content} class="flow-root">
        {props.children}
      </div>
    </div>
  );
}

afterEach(() => {
  cleanup();
  __resetEventsCache();
});

describe("a disclosure growing inside the panel's auto-sized frame", () => {
  it("is never cut by the frame in a panel under the cap, and leaves nothing held", async () => {
    slowMotion();
    let frame!: HTMLElement;
    render(() => (
      <Framed onFrame={(el) => (frame = el)}>
        <p>Two tables.</p>
        <Disclosure summary="Arrange tables">{lines()}</Disclosure>
        <p>Not seated: nobody.</p>
      </Framed>
    ));
    for (let i = 0; i < 5; i++) await nextFrame();
    const content = frame.firstElementChild as HTMLElement;
    const details = frame.querySelector("details")!;
    const closed = details.getBoundingClientRect().height;

    const sampler = sampleFrames(frame, content, () => details);
    await userEvent.click(screen.getByText("Arrange tables"));
    await settle();
    sampler.stop();

    const open = details.getBoundingClientRect().height;
    // Under the cap at the far end, so every step of the growth is one the
    // frame would animate.
    expect(content.getBoundingClientRect().height).toBeLessThan(AUTO_SIZE_CAP);
    // The disclosure grew over several frames, not in one jump.
    const partway = sampler.frames.filter((f) => f.box > closed + 1 && f.box < open - 1);
    expect(partway.length).toBeGreaterThan(2);
    // On no frame does the frame cut the panel's foot, nor take a height of
    // its own: it follows the growth to its last step.
    expect(sampler.frames.filter((f) => f.over > 1)).toEqual([]);
    expect(sampler.frames.filter((f) => f.inlineHeight !== "")).toEqual([]);
    expect(held(frame)).toEqual(["", "", ""]);
  });

  it("still moves between two views when one holds a disclosure open", async () => {
    let frame!: HTMLElement;
    const [view, setView] = createSignal<"list" | "guide">("list");
    const [more, setMore] = createSignal(false);
    render(() => (
      <Framed onFrame={(el) => (frame = el)}>
        <Show when={view() === "guide"} fallback={<p>No file chosen.</p>}>
          <Disclosure summary="How to structure your sheet" open>
            {/* Lays out as 100.328125px, whole 64ths, and its computed length
                is written as 100.328px: an open body at rest that reads a
                hair shorter than it is. */}
            <div style={{ height: "100.33px" }} />
          </Disclosure>
          <Show when={more()}>{lines()}</Show>
        </Show>
      </Framed>
    ));
    for (let i = 0; i < 5; i++) await nextFrame();
    const content = frame.firstElementChild as HTMLElement;

    /** Change the content, then read whether the frame moved to it. */
    async function moves(change: () => void): Promise<boolean> {
      const before = frame.getBoundingClientRect().height;
      const sampler = sampleFrames(frame, content, () => frame);
      change();
      await settle();
      sampler.stop();
      const after = frame.getBoundingClientRect().height;
      expect(Math.abs(after - before)).toBeGreaterThan(20);
      expect(after).toBeLessThan(AUTO_SIZE_CAP);
      expect(held(frame)).toEqual(["", "", ""]);
      const low = Math.min(before, after);
      const high = Math.max(before, after);
      return sampler.frames.some(
        (f) => f.inlineHeight !== "" && f.box > low + 1 && f.box < high - 1,
      );
    }

    // A view swapped in with its disclosure already open, and then a change
    // under that open disclosure: the frame moves to both.
    expect(await moves(() => setView("guide"))).toBe(true);
    // The open body at rest reads short by less than the slack, not by nothing.
    const details = frame.querySelector("details")!;
    const shown = Number.parseFloat(getComputedStyle(details, "::details-content").height);
    const body = details.lastElementChild!.getBoundingClientRect().height;
    expect(body - shown).toBeGreaterThan(0);
    expect(body - shown).toBeLessThan(0.01);
    expect(await moves(() => setMore(true))).toBe(true);
  });
});

describe("Arrange tables in the real module panel", () => {
  for (const viewport of VIEWPORTS) {
    it(`grows with the panel's foot uncut and nothing held after, at ${viewport.name}`, async () => {
      await page.viewport(viewport.width, viewport.height);
      authFetch.mockImplementation(async (input: unknown) => {
        const path = String(input).split("?")[0]!;
        if (path.includes("/seating")) return json(CHART);
        if (path.endsWith("/events")) return json([EVENT]);
        if (path.endsWith("/changes/head")) return json({ revision: "rev_1" });
        return json({});
      });

      renderOrganiserPage({ module: "seating", sub: "" });
      const summary = await screen.findByText("Arrange tables");
      await document.fonts.ready;
      for (let i = 0; i < 5; i++) await nextFrame();
      const frame = document.getElementById("subpanel-seating")!;
      const content = frame.firstElementChild as HTMLElement;
      const details = summary.closest("details")!;
      const closed = details.getBoundingClientRect().height;

      const sampler = sampleFrames(frame, content, () => details);
      await userEvent.click(summary);
      await settle();
      sampler.stop();
      await page.screenshot({
        path: `__screenshots__/ModuleShell.disclosure/arrange-tables-${viewport.name}.png`,
      });

      const open = details.getBoundingClientRect().height;
      expect(details.open).toBe(true);
      expect(open).toBeGreaterThan(closed + 40);
      const partway = sampler.frames.filter((f) => f.box > closed + 1 && f.box < open - 1);
      expect(partway.length).toBeGreaterThan(1);
      expect(sampler.frames.filter((f) => f.over > 1)).toEqual([]);
      expect(held(frame)).toEqual(["", "", ""]);
    });
  }
});
