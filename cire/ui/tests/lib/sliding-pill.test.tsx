// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSlidingPill,
  type PillEase,
  pillBox,
  pillStyle,
  type RectLike,
} from "../../src/lib/sliding-pill";

/**
 * happy-dom computes no layout: every rect is zero and there is no
 * ResizeObserver worth the name. So the geometry is tested as arithmetic, and
 * the wiring is tested against a stubbed rect source and a fake observer the
 * test can fire by hand. What that leaves unverified is whether the numbers a
 * real browser reports are the ones we want — which is a thing to look at, not
 * a thing to assert.
 */

const rect = (left: number, top: number, width: number, height: number): RectLike => ({
  left,
  top,
  width,
  height,
});

class FakeResizeObserver {
  static live: FakeResizeObserver[] = [];
  targets = new Set<Element>();
  disconnected = false;
  constructor(readonly cb: () => void) {
    FakeResizeObserver.live.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
    this.disconnected = true;
  }
  /** Every live observer reports, the way a reflow makes them. */
  static fire() {
    for (const o of FakeResizeObserver.live) if (!o.disconnected) o.cb();
  }
}

/** Two frames, so a value set inside `requestAnimationFrame` has landed. */
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

const originalRect = Element.prototype.getBoundingClientRect;

/**
 * Stubbed layout, keyed by each element's `data-testid`.
 *
 * The key has to be a *static* JSX attribute: Solid sets dynamic ones after the
 * ref callback runs, so a rect passed in as a prop would read as zero on the
 * first measure and the test would be measuring its own harness.
 */
let rects: Record<string, RectLike> = {};

beforeEach(() => {
  FakeResizeObserver.live = [];
  rects = {};
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const r = rects[this.getAttribute("data-testid") ?? ""] ?? rect(0, 0, 0, 0);
    return {
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
    } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
});

describe("pillBox", () => {
  it("reports the item's offset inside the track, not its page position", () => {
    // The track is 200px down the page; the item 40px inside it. The pill lives
    // in the track's coordinates, so the answer is 40, not 240.
    expect(pillBox(rect(0, 200, 220, 400), rect(0, 240, 220, 36))).toEqual({
      x: 0,
      y: 40,
      width: 220,
      height: 36,
    });
  });

  it("adds the track's scroll, so an overflowing strip stays aligned", () => {
    // A tab strip scrolled 120px right reports its items 120px further left
    // than they sit in its own content box.
    expect(pillBox(rect(0, 0, 300, 40), rect(-40, 0, 90, 32), { left: 120, top: 0 })).toEqual({
      x: 80,
      y: 0,
      width: 90,
      height: 32,
    });
  });

  it("measures both axes, so a wrapped strip lands on the right line", () => {
    // Second row of a strip that wrapped: same track, y is what tells them apart.
    expect(pillBox(rect(0, 0, 300, 80), rect(8, 44, 70, 32))?.y).toBe(44);
  });

  it("gives no position to a zero-area item", () => {
    // How a `display: none` copy of the nav reports itself. It must not claim
    // the pill away from the copy that is actually on screen.
    expect(pillBox(rect(0, 0, 220, 400), rect(0, 0, 0, 0))).toBeNull();
  });
});

describe("pillStyle", () => {
  it("hides the pill, without a transition, when there is nowhere to be", () => {
    expect(pillStyle(null, true)).toEqual({ opacity: 0, transition: "none" });
  });

  it("places an unsettled pill with the transition off", () => {
    // Arriving is not travelling: the first placement must not slide in from
    // the track's corner.
    const style = pillStyle({ x: 0, y: 40, width: 220, height: 36 }, false);
    expect(style.transform).toBe("translate3d(0px, 40px, 0)");
    expect(style.transition).toBe("none");
  });

  it("moves the rail's marker, place and size, on base and ease-out", () => {
    const move = timings(pillStyle({ x: 8, y: 44, width: 70, height: 32 }, true).transition);
    expect(Object.keys(move)).toEqual(["transform", "width", "height"]);
    // Tokens, not numbers — the reduced-motion switch overrides the duration.
    // Each falls back to the contract's, for a surface that defines no app token.
    for (const timing of Object.values(move)) {
      expect(timing).toContain("var(--dur-base,var(--ui-dur-base");
      expect(timing).toContain("var(--ease-out,var(--ui-ease-out");
    }
  });

  it("glides the glass's place on the firmer spring, on slow", () => {
    const move = timings(
      pillStyle({ x: 8, y: 44, width: 70, height: 32 }, true, "spring").transition,
    );
    expect(move.transform).toContain("var(--dur-slow,var(--ui-dur-slow");
    // A surface with no glide falls back to ease-out, never to the bouncier
    // house spring.
    expect(move.transform).toContain("var(--ease-glide,var(--ease-out,var(--ui-ease-out");
    expect(move.transform).not.toContain("--ease-spring");
  });

  it("eases the glass's size out on the same clock, so it never grows past its tab", () => {
    const move = timings(
      pillStyle({ x: 8, y: 44, width: 70, height: 32 }, true, "spring").transition,
    );
    for (const size of [move.width, move.height]) {
      expect(size).toContain("var(--dur-slow,var(--ui-dur-slow");
      expect(size).toContain("var(--ease-out,var(--ui-ease-out");
      expect(size).not.toContain("--ease-glide");
      expect(size).not.toContain("--ease-spring");
    }
  });

  it("jumps the glass, place and size, while it is not settled", () => {
    // `createSlidingPill` passes `settled` false for a reader who turned
    // motion down, as well as on the first frame at a new place.
    const style = pillStyle({ x: 8, y: 44, width: 70, height: 32 }, false, "spring");
    expect(style.transform).toBe("translate3d(8px, 44px, 0)");
    expect(style.width).toBe("70px");
    expect(style.transition).toBe("none");
  });
});

/** A `transition` shorthand as each property's own timing, split at its top-level commas. */
function timings(transition: unknown): Record<string, string> {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of String(transition)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  return Object.fromEntries(
    parts.map((part) => {
      const space = part.indexOf(" ");
      return [part.slice(0, space), part.slice(space + 1)];
    }),
  );
}

/**
 * A rail: track 100px down the page, two 36px rows 44px apart. The hook is
 * created inside `render` so it gets an owner, as it would in a component.
 */
function mount(ease?: PillEase) {
  rects.track = rect(0, 100, 220, 200);
  rects.one = rect(0, 108, 220, 36);
  rects.two = rect(0, 152, 220, 36);
  const [active, setActive] = createSignal("one");
  const utils = render(() => {
    const pill = createSlidingPill(active, { ease });
    return (
      <div ref={pill.track} data-testid="track">
        <span data-testid="pill" style={pill.style()} />
        <button ref={pill.item("one")} data-testid="one">
          One
        </button>
        <button ref={pill.item("two")} data-testid="two">
          Two
        </button>
      </div>
    );
  });
  const pillEl = () => utils.getByTestId("pill");
  return { ...utils, setActive, pillEl };
}

describe("createSlidingPill", () => {
  it("sits on the active item once it has measured", () => {
    const { pillEl } = mount();
    expect(pillEl().style.transform).toBe("translate3d(0px, 8px, 0)");
    expect(pillEl().style.height).toBe("36px");
  });

  it("does not animate into place on the first measure", () => {
    const { pillEl } = mount();
    expect(pillEl().style.transition).toBe("none");
  });

  it("travels, with a transition, when the active item changes", async () => {
    const { pillEl, setActive } = mount();
    await settle();
    setActive("two");
    expect(pillEl().style.transform).toBe("translate3d(0px, 52px, 0)");
    expect(pillEl().style.transition).toContain("transform");
  });

  it("re-measures when the track reflows under it", async () => {
    const { pillEl } = mount();
    await settle();
    // The rail got wider; the rows with it.
    rects.one = rect(0, 108, 260, 36);
    FakeResizeObserver.fire();
    expect(pillEl().style.width).toBe("260px");
  });

  it("snaps rather than slides when it was the track that changed width", async () => {
    // A window being dragged fires the observer every frame. The pill's new
    // place each time is not a move the host made, and sliding to it means the
    // pill lags its own label for the whole drag.
    const { pillEl } = mount();
    await settle();
    rects.track = rect(0, 100, 260, 200);
    rects.one = rect(0, 108, 260, 36);
    FakeResizeObserver.fire();
    expect(pillEl().style.width).toBe("260px");
    expect(pillEl().style.transition).toBe("none");
  });

  it("glides when created with the spring", async () => {
    rects.track = rect(0, 100, 220, 200);
    rects.one = rect(0, 108, 220, 36);
    rects.two = rect(0, 152, 220, 36);
    const [active, setActive] = createSignal("one");
    const utils = render(() => {
      const pill = createSlidingPill(active, { ease: "spring" });
      return (
        <div ref={pill.track} data-testid="track">
          <span data-testid="pill" style={pill.style()} />
          <button ref={pill.item("one")} data-testid="one">
            One
          </button>
          <button ref={pill.item("two")} data-testid="two">
            Two
          </button>
        </div>
      );
    });
    await settle();
    setActive("two");
    expect(utils.getByTestId("pill").style.transition).toContain("--ease-glide");
  });

  for (const ease of ["out", "spring"] as const) {
    it(`jumps rather than slides for a reader who has turned motion down, on ${ease}`, async () => {
      const before = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes("prefers-reduced-motion: reduce"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia;
      try {
        const { pillEl, setActive } = mount(ease);
        await settle();
        setActive("two");
        expect(pillEl().style.transform).toBe("translate3d(0px, 52px, 0)");
        expect(pillEl().style.transition).toBe("none");
      } finally {
        window.matchMedia = before;
      }
    });
  }

  it("hides itself when the active key names no item", async () => {
    const { pillEl, setActive } = mount();
    await settle();
    setActive("nowhere");
    expect(pillEl().style.opacity).toBe("0");
  });

  it("stops observing when the component goes away", () => {
    mount();
    expect(FakeResizeObserver.live).toHaveLength(1);
    cleanup();
    expect(FakeResizeObserver.live[0]!.disconnected).toBe(true);
  });
});
