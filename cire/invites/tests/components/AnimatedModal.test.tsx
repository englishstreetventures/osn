/**
 * What this tier can and cannot see.
 *
 * The sheet is `@shared/ui`'s `Modal` now, so Escape, the backdrop, the focus trap
 * and the focus restore are the platform's — and jsdom implements no part of
 * `<dialog>`: `showModal` is `undefined`, nothing is focused on open, and every
 * box measures zero. `Modal` degrades to a non-modal dialog there, which is
 * enough to assert structure, wiring and the class contract, and nothing at all
 * about the gestures. Those live in `AnimatedModal.browser.test.tsx`.
 */

import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import { AnimatedModal } from "../../src/components/AnimatedModal";

/**
 * The panel is a non-scrolling frame whose only in-flow child is the scroll
 * container (without a toolbar, the close button is absolutely positioned
 * alongside it; with one, it is in the bar inside it). Padding and overflow
 * live on the scroller, so assertions about them target this.
 */
function scrollerOf(panel: HTMLElement): HTMLElement {
  return panel.lastElementChild as HTMLElement;
}

describe("AnimatedModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Defensive: ensure the body scroll lock is never left applied between tests.
    document.documentElement.style.overflow = "";
    document.documentElement.style.scrollbarGutter = "";
  });

  it("names the dialog via labelledBy → the referenced title element", () => {
    const { getByRole, getByText } = render(() => (
      <AnimatedModal onClose={() => {}} labelledBy="modal-title">
        <h2 id="modal-title">Mehndi</h2>
      </AnimatedModal>
    ));

    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe("modal-title");
    // The accessible name resolves to the referenced title's text.
    expect(getByText("Mehndi").id).toBe("modal-title");
    // Querying the dialog by its accessible name succeeds.
    expect(getByRole("dialog", { name: "Mehndi" })).toBe(dialog);
  });

  it("applies allow-listed themeVars to the dialog panel and drops stray keys", () => {
    const { getByRole } = render(() => (
      <AnimatedModal
        onClose={() => {}}
        label="Event details"
        themeVars={{
          "--invite-section-bg": "var(--color-surface-raised)",
          "--color-gold": "oklch(74.99% 0.0854 82.08)",
          // NOT in the theme-variable allow-list — must never reach the DOM
          // (the prop is a style sink; the component enforces the contract).
          "background-image": "url(https://evil.example/x)",
        }}
      >
        <p>body</p>
      </AnimatedModal>
    ));

    const dialog = getByRole("dialog");
    expect(dialog.style.getPropertyValue("--invite-section-bg")).toBe(
      "var(--color-surface-raised)",
    );
    expect(dialog.style.getPropertyValue("--color-gold")).toBe("oklch(74.99% 0.0854 82.08)");
    expect(dialog.style.getPropertyValue("background-image")).toBe("");
  });

  it("falls back to an aria-label when no labelledBy is supplied", () => {
    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Event details");
    expect(dialog.getAttribute("aria-labelledby")).toBeNull();
  });

  it("asks the platform to focus the scroll container, not the close button", () => {
    const { getByRole, getByLabelText } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    // `autofocus` rather than an imperative `focus()`: a dialog's focusing
    // steps prefer the autofocus delegate over the first tabbable descendant,
    // which is the close button. That button is a sibling of the scrollport, so
    // landing there leaves the keyboard with nothing to scroll — the frame
    // above it is `overflow-clip`, which is not a scroll container at all, and
    // beyond it is a `<body>` this component locks. Measured in a real browser with focus on the button:
    // Arrow and PageDown moved a scrollable sheet 0px. With focus on the
    // scrollport: ArrowDown 0→40px, PageDown 40→594px, Home back to 0.
    // That it actually lands there is the browser tier's to check.
    const scroller = scrollerOf(getByRole("dialog"));
    expect(scroller.hasAttribute("autofocus")).toBe(true);
    expect(getByLabelText("Close").hasAttribute("autofocus")).toBe(false);
  });

  it("tells its caller about a close the platform performed", async () => {
    // Escape and a backdrop click both arrive as the dialog's `close` event,
    // and this is the wiring that turns that into `onClose` — without it the
    // consumer's `<Show>` stays true against a dialog that has already shut.
    const onClose = vi.fn();
    const { getByRole } = render(() => (
      <AnimatedModal onClose={onClose} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    getByRole("dialog").dispatchEvent(new Event("close"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["in the corner", false],
    ["in a toolbar's bar", true],
  ])("closes via the close button %s", async (_, toolbar) => {
    const onClose = vi.fn();
    const { getByLabelText } = render(() => (
      <AnimatedModal onClose={onClose} label="Event details" toolbar={toolbar}>
        <p>body</p>
      </AnimatedModal>
    ));

    fireEvent.click(getByLabelText("Close"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the close button outside the scroll container so it cannot scroll away", () => {
    const { getByRole, getByLabelText } = render(() => (
      <AnimatedModal onClose={() => {}} label="Scrollable">
        <p>body</p>
      </AnimatedModal>
    ));

    const panel = getByRole("dialog");
    const close = getByLabelText("Close");
    const scroller = scrollerOf(panel);

    // The regression this guards: as an `absolute` child of the scroll
    // container, the close button left the viewport entirely on any sheet tall
    // enough to scroll, leaving Escape or a backdrop tap as the only way out.
    expect(scroller.contains(close)).toBe(false);
    expect(panel.contains(close)).toBe(true);

    // The frame must not scroll, or the button rides it anyway.
    expect(panel.className).not.toContain("overflow-y-auto");
    expect(scroller.className).toContain("overflow-y-auto");
    // Without `min-h-0` the flex item cannot shrink under the panel's `max-h`,
    // so nothing scrolls and the panel simply overflows the viewport.
    expect(scroller.className).toContain("min-h-0");
    // Opaque, because content now passes underneath the button as it scrolls.
    expect(close.className).toContain("bg-surface");
    expect(close.className).not.toContain("bg-transparent");
    // And ranked, because some of what passes underneath is positioned. The
    // dietary pills carry `relative` so their `sr-only` inputs resolve inside
    // the pill, which puts sixteen positioned boxes later in the tree than this
    // chip — and tree order alone then hands them the hit test. Measured in
    // `DietaryPresets.browser.test.tsx`; this is the cheap half. The rank is
    // on the row the button sits in, which is what is positioned.
    expect(close.parentElement!.className.split(/\s+/)).toContain("z-10");

    // Still the first thing in the tab order, as before the restructure.
    expect(panel.querySelector("button")).toBe(close);

    // The scrollport must be focusable itself: it is where focus lands on open,
    // and a focusable scrolling region is what gives it a keyboard at all.
    expect(scroller.getAttribute("tabindex")).toBe("0");
    // Tabbing BACKWARDS scrolls a target to the top of the scrollport, which is
    // exactly where the close chip sits — reserve its 52px footprint so no
    // control is ever parked underneath it.
    expect(scroller.className).toContain("scroll-pt-14");
  });

  it("draws a toolbar's title, action and close button in a bar at the top of the scroller", () => {
    const { getByRole } = render(() => (
      <AnimatedModal
        onClose={() => {}}
        labelledBy="sheet-title"
        toolbar
        title={<h2 id="sheet-title">Mehndi</h2>}
        action={<button type="button">Give RSVP</button>}
      >
        <p>Body</p>
      </AnimatedModal>
    ));
    const close = getByRole("button", { name: "Close" });
    const action = getByRole("button", { name: "Give RSVP" });
    const title = getByRole("heading", { name: "Mehndi" });
    const scroller = scrollerOf(close.closest("dialog")!);
    const bar = close.parentElement!;

    // Inside the scrollport, ahead of the content, so the content scrolls
    // under it: the bar is `sticky`, and a sticky box only stays put over the
    // box that scrolls it.
    expect(scroller.firstElementChild).toBe(bar);
    expect(bar.contains(title)).toBe(true);
    // Title, then the action, then the cross, which keeps its corner.
    expect(action.parentElement).toBe(bar);
    expect(action.nextElementSibling).toBe(close);
    expect(title.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.className.split(/\s+/)).toEqual(expect.arrayContaining(["sticky", "top-0", "z-10"]));
    // The bar takes its own height in flow, so the content needs no top
    // padding to clear it; it grows with a title that wraps, and focus
    // scrolling keeps a target below whatever height it has.
    expect(scroller.className).not.toMatch(/(^|\s)pt-(8|16)(\s|$)/);
    expect(bar.className.split(/\s+/)).toContain("min-h-15");
    expect(scroller.className.split(/\s+/)).toContain("scroll-pt-[var(--sheet-bar,3.75rem)]");
  });

  it("keeps the plain top padding without a toolbar", () => {
    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>Body</p>
      </AnimatedModal>
    ));
    const scroller = scrollerOf(getByRole("button", { name: "Close" }).closest("dialog")!);
    expect(scroller.className).toContain("pt-8");
  });

  it("hands the scroll container to scrollRef", () => {
    let received: HTMLDivElement | undefined;
    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details" scrollRef={(el) => (received = el)}>
        <p>body</p>
      </AnimatedModal>
    ));

    expect(received).toBe(scrollerOf(getByRole("dialog")));
  });

  it("keeps its own bottom padding by default, and drops it for flushBottom", () => {
    const { getByRole, unmount } = render(() => (
      <AnimatedModal onClose={() => {}} label="Default">
        <p>body</p>
      </AnimatedModal>
    ));
    const scroller = scrollerOf(getByRole("dialog"));
    expect(scroller.className).toContain("pb-[max(2.5rem,env(safe-area-inset-bottom))]");
    expect(scroller.className).toContain("md:pb-10");
    unmount();

    const flush = render(() => (
      <AnimatedModal onClose={() => {}} label="Flush" flushBottom>
        <p>body</p>
      </AnimatedModal>
    ));
    const flushScroller = scrollerOf(flush.getByRole("dialog"));
    // A full-bleed sticky action bar owns the bottom edge — the scroller must
    // add nothing under it, or the bar floats above a dead band of surface.
    expect(flushScroller.className).toContain("pb-0");
    // Assert the branch is exclusive. `toContain("pb-0")` alone is satisfied by
    // a class list carrying BOTH paddings, and Tailwind resolves that clash by
    // stylesheet source order — not by the order of the class attribute.
    expect(flushScroller.className).not.toContain("pb-[max(2.5rem");
    expect(flushScroller.className).not.toContain("md:pb-10");
  });
});
