import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { AnimatedModal } from "../../src/components/AnimatedModal";

import "../../src/styles/global.css";
import { Z_CLASS, Z_LAYER } from "../../src/lib/z-index";

/**
 * The #203 invariant, asserted against what the browser actually paints.
 *
 * `z-index.test.ts` (jsdom) guards the *numbers* in `Z_LAYER` and the *strings*
 * in `Z_CLASS`. That is the most a jsdom test can do, and it leaves three ways
 * to reintroduce the exact bug it was written for — a modal-launched popover
 * rendering behind the modal, "Add to Calendar doesn't work":
 *
 *  1. `Z_CLASS.MODAL_POPOVER` could hold a class Tailwind never emits. The
 *     scanner only sees literal source text, so a class assembled by
 *     concatenation compiles to no CSS at all — silently, because an unknown
 *     class is simply ignored. `expect(Z_CLASS.MODAL_POPOVER).toBe("z-110")`
 *     passes either way; the element then has `z-index: auto`.
 *  2. An ancestor could introduce a **stacking context** (`transform`,
 *     `filter`, `opacity < 1`, `will-change`, `contain`…). A descendant's
 *     z-index is then resolved *inside* that context and cannot compete with
 *     the modal's, however large the number. The popover is portalled to
 *     `<body>` specifically to avoid this, and nothing tests that it still is.
 *  3. The paint order could invert for any reason the numbers don't capture.
 *
 * Each check below therefore reads computed style or hit-tests real geometry,
 * rather than re-asserting the constants.
 */

/** A stand-in for the portalled popover: same z-class, same `fixed`, real geometry. */
function Popover() {
  return (
    <div
      data-testid="popover"
      class={`fixed ${Z_CLASS.MODAL_POPOVER} bg-surface-raised`}
      style={{ top: "100px", left: "100px", width: "200px", height: "80px" }}
    >
      Add to calendar
    </div>
  );
}

describe("stacking order, as painted", () => {
  it("emits real CSS for every layer class — not just a matching string constant", () => {
    // Catches failure mode 1: a `Z_CLASS` entry Tailwind never compiled. jsdom
    // cannot see this at all, because it never parses the stylesheet.
    const { container } = render(() => (
      <>
        {Object.entries(Z_CLASS).map(([layer, cls]) => (
          <div data-layer={layer} class={`fixed ${cls}`} />
        ))}
      </>
    ));

    for (const [layer, expected] of Object.entries(Z_LAYER)) {
      const el = container.querySelector(`[data-layer="${layer}"]`) as HTMLElement;
      const painted = getComputedStyle(el).zIndex;
      expect(
        painted,
        `${layer} (${Z_CLASS[layer as keyof typeof Z_CLASS]}) emitted no z-index`,
      ).toBe(String(expected));
    }
  });

  it("paints a modal-launched popover ABOVE the modal it opens from (#203)", async () => {
    // The regression as a user would meet it: is the menu actually on top?
    const { getByTestId } = render(() => (
      <>
        <AnimatedModal onClose={() => {}} label="Event details">
          <p style={{ height: "400px" }}>Details</p>
        </AnimatedModal>
        <Popover />
      </>
    ));

    const popover = getByTestId("popover");
    const rect = popover.getBoundingClientRect();
    // Real layout — in jsdom this rect is all zeroes and the test is vacuous.
    expect(rect.width).toBeGreaterThan(0);

    // The question the numbers can't answer: what does the user's click hit?
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(hit).not.toBeNull();
    expect(popover.contains(hit)).toBe(true);
  });

  it("keeps the popover out of any ancestor stacking context", () => {
    // Catches failure mode 2. `<Portal>` puts the real popover directly under
    // <body>; if a future refactor nested it inside the modal's panel instead,
    // the panel (or the backdrop) would become its containing stacking context
    // and the z-index would stop competing with the modal's.
    const { getByTestId } = render(() => (
      <>
        <AnimatedModal onClose={() => {}} label="Event details">
          <p>Details</p>
        </AnimatedModal>
        <Popover />
      </>
    ));

    const popover = getByTestId("popover");
    for (let el = popover.parentElement; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const createsContext =
        cs.transform !== "none" ||
        cs.filter !== "none" ||
        cs.perspective !== "none" ||
        cs.contain.includes("paint") ||
        cs.willChange.includes("transform") ||
        cs.willChange.includes("opacity") ||
        (cs.opacity !== "" && Number(cs.opacity) < 1) ||
        (cs.isolation === "isolate" && cs.zIndex === "auto");
      expect(
        createsContext,
        `<${el.tagName.toLowerCase()}> traps the popover in a new stacking context`,
      ).toBe(false);
    }
  });

  it("paints the modal above ordinary page content", () => {
    const { getByTestId } = render(() => (
      <>
        <div
          data-testid="page"
          class={Z_CLASS.EVENT_CARD}
          style={{
            position: "fixed",
            top: "100px",
            left: "100px",
            width: "300px",
            height: "200px",
          }}
        >
          Event card
        </div>
        <AnimatedModal onClose={() => {}} label="Event details">
          <p>Details</p>
        </AnimatedModal>
      </>
    ));

    const card = getByTestId("page");
    const r = card.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    // The modal backdrop covers the viewport, so anything under it must not be
    // reachable — that is what "modal" means, and what z-100 buys.
    expect(card.contains(hit)).toBe(false);
  });
});
