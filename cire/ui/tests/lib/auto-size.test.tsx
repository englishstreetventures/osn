// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTO_SIZE_CAP, autoSizeAnimates, createAutoSize } from "../../src/lib/auto-size";

/**
 * As with the sliding pill: happy-dom has no layout, so the rule about what is
 * worth animating is tested as arithmetic and the wiring is tested against a
 * stubbed rect and a fake observer fired by hand.
 */

class FakeResizeObserver {
  static live: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(readonly cb: () => void) {
    FakeResizeObserver.live.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  static fire() {
    for (const o of FakeResizeObserver.live) if (!o.disconnected) o.cb();
  }
}

const originalRect = Element.prototype.getBoundingClientRect;

/**
 * The content's height, as the stubbed layout reports it. A plain variable
 * rather than an attribute on the element: JSX sets dynamic attributes *after*
 * the ref callback runs, so an attribute would read as 0 on the first measure
 * and the test would be measuring its own harness.
 */
let contentHeight = 0;

/** The content's width, same idea. Only a *change* of it means anything. */
let contentWidth = 320;

beforeEach(() => {
  FakeResizeObserver.live = [];
  contentHeight = 0;
  contentWidth = 320;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Element.prototype.getBoundingClientRect = function () {
    const h = contentHeight;
    const w = contentWidth;
    return { left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0 } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("autoSizeAnimates", () => {
  it("never animates the first measure", () => {
    // There is no height to travel from — the box would grow out of nothing.
    expect(autoSizeAnimates(null, 120)).toBe(false);
  });

  it("animates a short move", () => {
    expect(autoSizeAnimates(96, 180)).toBe(true);
  });

  it("snaps when either end is taller than the cap", () => {
    // Long distances read as a wipe, not a movement — in both directions, so a
    // collapse from something enormous snaps too.
    expect(autoSizeAnimates(120, AUTO_SIZE_CAP + 1)).toBe(false);
    expect(autoSizeAnimates(AUTO_SIZE_CAP + 1, 120)).toBe(false);
  });

  it("takes the cap as a parameter", () => {
    expect(autoSizeAnimates(100, 200, 150)).toBe(false);
    expect(autoSizeAnimates(100, 200, 400)).toBe(true);
  });
});

/** The hook is created inside `render` so it gets an owner, as in a component. */
function mount(height: number, cap?: number) {
  contentHeight = height;
  let size: ReturnType<typeof createAutoSize>;
  const utils = render(() => {
    size = createAutoSize(cap);
    return (
      <div ref={size.frame} data-testid="frame">
        <div ref={size.content} data-testid="content" />
      </div>
    );
  });
  return {
    ...utils,
    size: size!,
    frame: () => utils.getByTestId("frame"),
    content: () => utils.getByTestId("content"),
  };
}

/** Content grows or shrinks, and the observer reports it. */
function resizeTo(height: number) {
  contentHeight = height;
  FakeResizeObserver.fire();
}

/**
 * A `transitionend`, as the browser would raise it.
 *
 * `TransitionEvent` is not constructible in happy-dom, and the handler reads two
 * things off it: `propertyName` and `target`. The first is assigned; the second
 * is set by dispatch.
 */
function endTransition(el: Element, propertyName: string, bubbles = true) {
  el.dispatchEvent(Object.assign(new Event("transitionend", { bubbles }), { propertyName }));
}

describe("createAutoSize", () => {
  it("holds nothing at rest", () => {
    // The whole point of the redesign: a frame at rest is an ordinary box. A
    // permanent clip would cut off sticky bars and unportalled popovers in every
    // module the panel wraps.
    const { frame } = mount(120);
    expect(frame().style.height).toBe("");
    expect(frame().style.overflow).toBe("");
    expect(frame().style.transition).toBe("");
  });

  it("clips and takes a height while it is moving", () => {
    const { frame } = mount(120);
    resizeTo(180);
    expect(frame().style.height).toBe("180px");
    expect(frame().style.overflow).toBe("hidden");
    expect(frame().style.transition).toContain("height");
    expect(frame().style.transition).toContain("var(--dur-base)");
  });

  it("lets go when the height transition ends", () => {
    const { frame } = mount(120);
    resizeTo(180);
    endTransition(frame(), "height");
    expect(frame().style.height).toBe("");
    expect(frame().style.overflow).toBe("");
  });

  it("stays clipped for a transition that belongs to something inside it", () => {
    // Children transition all the time — a row's colour, a button's border. Those
    // bubble through the frame and must not be mistaken for its own move ending.
    const { frame, content } = mount(120);
    resizeTo(180);
    endTransition(content(), "opacity");
    expect(frame().style.height).toBe("180px");
  });

  it("lets go on the backstop when no transition ever ends", () => {
    // A frame torn out of the layout mid-move, or a tab hidden before it settled,
    // never gets its `transitionend`. Stuck at a fixed height is the one state
    // this hook exists to avoid.
    vi.useFakeTimers();
    const { frame } = mount(120);
    resizeTo(180);
    expect(frame().style.height).toBe("180px");
    vi.advanceTimersByTime(1000);
    expect(frame().style.height).toBe("");
  });

  it("touches nothing at all for a change past the cap", () => {
    // Past the cap there is no animation, and with no animation there is no
    // reason to write a height or a clip the frame would then have to shed.
    const { frame } = mount(120);
    resizeTo(AUTO_SIZE_CAP + 400);
    expect(frame().style.height).toBe("");
    expect(frame().style.overflow).toBe("");
  });

  it("snaps when the width changed too, because that is a reflow", () => {
    // A window dragged narrower rewraps the text and the box gets taller. Sliding
    // to it means the frame trails its own content for the whole drag.
    const { frame } = mount(120);
    contentWidth = 240;
    resizeTo(180);
    expect(frame().style.height).toBe("");
    expect(frame().style.overflow).toBe("");
  });

  it("animates again once the width has settled", () => {
    // The drag ends, and the next change of content is a change of content.
    const { frame } = mount(120);
    contentWidth = 240;
    resizeTo(180);
    resizeTo(210);
    expect(frame().style.height).toBe("210px");
  });

  it("does not measure a frame that has left the document", () => {
    // A torn-out element reports zero on every axis, and a frame told it is 0px
    // tall is a frame that collapses the moment it is put back.
    const { size, content } = mount(120);
    content().remove();
    resizeTo(0);
    expect(size.height()).toBe(120);
  });

  it("reports the measured height", () => {
    const { size } = mount(96);
    expect(size.height()).toBe(96);
  });

  it("stops observing when the component goes away", () => {
    mount(120);
    cleanup();
    expect(FakeResizeObserver.live.every((o) => o.disconnected)).toBe(true);
  });
});
