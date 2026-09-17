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
 *  2. The menu could stop entering the **top layer**. The sheet is a
 *     `showModal()` dialog, so it paints above every stacking context in the
 *     document and no z-index reaches it; the menu shows itself as a `popover`
 *     to join it there. Drop that and the number is back to being unwinnable.
 *  3. The menu could be moved out of the dialog. A modal dialog makes the rest
 *     of the document INERT, and an inert element is not hit-testable however
 *     it is painted — so a menu portalled to `<body>`, as this one used to be,
 *     is visible and dead. That is the same bug report as #203 from the
 *     guest's side.
 *  4. The paint order could invert for any reason the numbers don't capture.
 *
 * Each check below therefore reads computed style or hit-tests real geometry,
 * rather than re-asserting the constants.
 */
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import { AnimatedModal } from "../../src/components/AnimatedModal";

import "../../src/styles/global.css";
import { Z_CLASS, Z_LAYER } from "../../src/lib/z-index";

/**
 * A stand-in for the menu: same z-class, same `fixed`, same entry into the top
 * layer, real geometry — and rendered where the real one is, INSIDE the sheet.
 *
 * Both of those make it a stand-in rather than a fiction. A double carrying
 * only `z-110` would be asserting an arrangement the app cannot ship, and one
 * rendered as a sibling of the sheet would be inert — reachable in the test and
 * not by a guest.
 */
function Popover() {
  return (
    <div
      data-testid="popover"
      ref={(el) => {
        if (typeof el.showPopover !== "function") return;
        el.setAttribute("popover", "manual");
        // A `ref` runs before the element is inserted, and `showPopover()` on a
        // disconnected element throws. Same deferral the real one makes.
        queueMicrotask(() => {
          if (el.isConnected) el.showPopover();
        });
      }}
      class={`fixed ${Z_CLASS.MODAL_POPOVER} bg-surface-raised inset-auto m-0`}
      style={{ top: "100px", left: "100px", width: "200px", height: "80px" }}
    >
      Add to calendar
    </div>
  );
}

/** One task, so a deferred `showPopover()` has run and layout has settled. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("stacking order, as painted", () => {
  // Without this every test's dialog stays open in the top layer, and the next
  // one's `document.querySelector("dialog")` finds a stale one.
  afterEach(cleanup);

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
    // Top-layer order is ENTRY order, and the popover shows itself after the
    // dialog has opened — which is what puts it above, now that out-numbering
    // the dialog is no longer possible.
    const [menuOpen, setMenuOpen] = createSignal(false);
    const { getByTestId } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p style={{ height: "400px" }}>Details</p>
        <Show when={menuOpen()}>
          <Popover />
        </Show>
      </AnimatedModal>
    ));

    // The sheet first, the menu second — which is the only order a guest can
    // produce, since the button that opens the menu is inside the sheet. It is
    // also the order that decides the answer: both are in the top layer, and
    // the top layer is painted in entry order.
    setMenuOpen(true);
    await tick();

    const popover = getByTestId("popover");
    expect(popover.matches(":popover-open")).toBe(true);
    const rect = popover.getBoundingClientRect();
    // Real layout — in jsdom this rect is all zeroes and the test is vacuous.
    expect(rect.width).toBeGreaterThan(0);

    // The question the numbers can't answer: what does the user's click hit?
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(hit).not.toBeNull();
    expect(popover.contains(hit)).toBe(true);
  });

  it("stays reachable inside the sheet, which the page around it is not", async () => {
    // Catches failure mode 3. A modal dialog makes every node outside it inert,
    // and inert is invisible to hit-testing and to assistive technology however
    // the element is painted — so the old answer to failure mode 2, portalling
    // the menu to `<body>`, is now the bug rather than the fix. Being a
    // descendant of the dialog is what keeps it live; being a popover is what
    // keeps it unclipped and unstacked, which is what the portal was for.
    const { getByTestId } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p style={{ height: "400px" }}>Details</p>
        <Popover />
      </AnimatedModal>
    ));

    const popover = getByTestId("popover");
    await tick();

    const dialog = document.querySelector("dialog")!;
    expect(dialog.contains(popover), "the menu is outside the sheet, and therefore inert").toBe(
      true,
    );
    expect(popover.matches(":popover-open")).toBe(true);

    // And the consequence, measured rather than reasoned about: a click at the
    // menu's centre reaches the menu.
    const rect = popover.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(popover.contains(hit)).toBe(true);
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
