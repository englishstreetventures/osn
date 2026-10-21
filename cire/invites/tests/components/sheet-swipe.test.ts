import { describe, expect, it } from "vitest";

import {
  beginsDrag,
  clampOffset,
  pastSlop,
  shouldCommit,
  startsInside,
  velocityOf,
} from "../../src/components/sheet-swipe";

const WIDTH = 400;

describe("beginsDrag", () => {
  it("refuses a move that is mostly vertical", () => {
    expect(beginsDrag({ dx: -20, dy: 30, panel: "details" })).toBe(false);
  });

  it("refuses a move toward the side with no panel", () => {
    // Details is the start-side panel: nothing lies to its left.
    expect(beginsDrag({ dx: 40, dy: 0, panel: "details" })).toBe(false);
    expect(beginsDrag({ dx: -40, dy: 0, panel: "rsvp" })).toBe(false);
  });

  it("refuses a move exactly as wide as it is tall", () => {
    expect(beginsDrag({ dx: -20, dy: 20, panel: "details" })).toBe(false);
  });

  it("refuses a move still inside the slop", () => {
    expect(beginsDrag({ dx: -10, dy: 0, panel: "details" })).toBe(false);
  });

  it("begins a horizontal move toward the other panel", () => {
    expect(beginsDrag({ dx: -11, dy: 2, panel: "details" })).toBe(true);
    expect(beginsDrag({ dx: 11, dy: -2, panel: "rsvp" })).toBe(true);
  });
});

describe("pastSlop", () => {
  it("waits while the touch stays within 10px both ways", () => {
    expect(pastSlop(10, -10)).toBe(false);
  });

  it("decides once the touch leaves the slop in either axis", () => {
    expect(pastSlop(0, 11)).toBe(true);
    expect(pastSlop(-11, 0)).toBe(true);
  });
});

describe("clampOffset", () => {
  it("never moves the panel away from its direction of travel", () => {
    expect(clampOffset(30, "details", WIDTH)).toBe(0);
    expect(clampOffset(-30, "rsvp", WIDTH)).toBe(0);
  });

  it("never moves the panel further than its own width", () => {
    expect(clampOffset(-900, "details", WIDTH)).toBe(-WIDTH);
    expect(clampOffset(900, "rsvp", WIDTH)).toBe(WIDTH);
  });

  it("passes an offset inside both bounds through", () => {
    expect(clampOffset(-120, "details", WIDTH)).toBe(-120);
  });
});

describe("shouldCommit", () => {
  it("springs back from a slow, short drag", () => {
    expect(shouldCommit({ dx: -60, velocity: -0.06, width: WIDTH, panel: "details" })).toBe(false);
  });

  it("commits a drag past three tenths of the width, however slow", () => {
    expect(shouldCommit({ dx: -121, velocity: 0, width: WIDTH, panel: "details" })).toBe(true);
    expect(shouldCommit({ dx: 121, velocity: 0, width: WIDTH, panel: "rsvp" })).toBe(true);
  });

  it("springs back from a drag of exactly three tenths", () => {
    expect(shouldCommit({ dx: -120, velocity: 0, width: WIDTH, panel: "details" })).toBe(false);
  });

  it("commits a fast flick toward the other panel", () => {
    expect(shouldCommit({ dx: -40, velocity: -0.5, width: WIDTH, panel: "details" })).toBe(true);
  });

  it("springs back from a flick under 24px, however fast", () => {
    expect(shouldCommit({ dx: -20, velocity: -2, width: WIDTH, panel: "details" })).toBe(false);
    expect(shouldCommit({ dx: -24, velocity: -2, width: WIDTH, panel: "details" })).toBe(false);
  });

  it("springs back from a flick at exactly the flick speed", () => {
    expect(shouldCommit({ dx: -40, velocity: -0.35, width: WIDTH, panel: "details" })).toBe(false);
    expect(shouldCommit({ dx: 40, velocity: 0.35, width: WIDTH, panel: "rsvp" })).toBe(false);
    expect(shouldCommit({ dx: 40, velocity: 0.36, width: WIDTH, panel: "rsvp" })).toBe(true);
  });

  it("springs back from a flick that turned back the other way", () => {
    expect(shouldCommit({ dx: -60, velocity: 0.5, width: WIDTH, panel: "details" })).toBe(false);
  });
});

describe("velocityOf", () => {
  it("measures px per ms over the last 100ms only", () => {
    const samples = [
      { x: 0, t: 0 }, // older than the window: ignored
      { x: -10, t: 400 },
      { x: -60, t: 500 },
    ];
    expect(velocityOf(samples)).toBeCloseTo(-0.5);
  });

  it("is zero with fewer than two samples in the window", () => {
    expect(velocityOf([{ x: 0, t: 0 }])).toBe(0);
    expect(velocityOf([])).toBe(0);
    expect(
      velocityOf([
        { x: 0, t: 0 },
        { x: -50, t: 300 },
      ]),
    ).toBe(0);
  });

  it("measures two samples inside the window", () => {
    expect(
      velocityOf([
        { x: 0, t: 0 },
        { x: -50, t: 100 },
      ]),
    ).toBeCloseTo(-0.5);
  });

  it("is zero, not infinite, for two samples at one instant", () => {
    expect(
      velocityOf([
        { x: 0, t: 10 },
        { x: -50, t: 10 },
      ]),
    ).toBe(0);
  });
});

describe("startsInside", () => {
  /** A computed-style stub keyed by element, so jsdom's missing layout is not consulted. */
  function styles(map: Map<Element, string>) {
    return (el: Element) => ({ overflowX: map.get(el) ?? "visible" }) as CSSStyleDeclaration;
  }

  function setWidths(el: HTMLElement, scrollWidth: number, clientWidth: number) {
    Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  }

  it.each(["input", "textarea", "select"])("refuses a start in a %s", (tag) => {
    const root = document.createElement("div");
    const field = document.createElement(tag);
    root.append(field);
    expect(startsInside(field, root, styles(new Map()))).toBe(true);
  });

  it("refuses a start inside contenteditable text", () => {
    const root = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.append(inner);
    root.append(editable);
    expect(startsInside(inner, root, styles(new Map()))).toBe(true);
  });

  it("refuses a start inside a box that scrolls sideways", () => {
    const root = document.createElement("div");
    const track = document.createElement("div");
    const pill = document.createElement("button");
    track.append(pill);
    root.append(track);
    setWidths(track, 800, 300);
    expect(startsInside(pill, root, styles(new Map([[track, "auto"]])))).toBe(true);
  });

  it("refuses a start inside an overflow-x: scroll box with more to show", () => {
    const root = document.createElement("div");
    const track = document.createElement("div");
    const pill = document.createElement("button");
    track.append(pill);
    root.append(track);
    setWidths(track, 800, 300);
    expect(startsInside(pill, root, styles(new Map([[track, "scroll"]])))).toBe(true);
  });

  it("allows a start inside a box whose overflow is clipped, not scrolled", () => {
    const root = document.createElement("div");
    const track = document.createElement("div");
    const pill = document.createElement("button");
    track.append(pill);
    root.append(track);
    setWidths(track, 800, 300);
    expect(startsInside(pill, root, styles(new Map([[track, "hidden"]])))).toBe(false);
  });

  it("allows a start inside an overflow-x box with nothing to scroll", () => {
    const root = document.createElement("div");
    const track = document.createElement("div");
    const pill = document.createElement("button");
    track.append(pill);
    root.append(track);
    setWidths(track, 300, 300);
    expect(startsInside(pill, root, styles(new Map([[track, "auto"]])))).toBe(false);
  });

  it("does not look past the root", () => {
    const outer = document.createElement("div");
    const root = document.createElement("div");
    const text = document.createElement("p");
    root.append(text);
    outer.append(root);
    setWidths(outer, 800, 300);
    expect(startsInside(text, root, styles(new Map([[outer, "scroll"]])))).toBe(false);
  });
});
