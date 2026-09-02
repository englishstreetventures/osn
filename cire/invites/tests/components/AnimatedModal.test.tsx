import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import { AnimatedModal } from "../../src/components/AnimatedModal";

// The open/close animation is imported dynamically; stub it so the modal's
// imperative reveal is a no-op under the test DOM.
vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

/**
 * The panel is a non-scrolling frame whose only in-flow child is the scroll
 * container (the close button is absolutely positioned alongside it). Padding
 * and overflow live on the scroller, so assertions about them target this.
 */
function scrollerOf(panel: HTMLElement): HTMLElement {
  return panel.lastElementChild as HTMLElement;
}

describe("AnimatedModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Defensive: ensure the body scroll lock is never left applied between tests.
    document.body.style.overflow = "";
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

  it("moves focus to the scroll container on open, so the keyboard can scroll it", async () => {
    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    // NOT the close button. That button is a sibling of the scrollport, so
    // focusing it leaves the keyboard with nothing to scroll — its nearest
    // scrollable ancestor is the `overflow-hidden` frame, then a `<body>` this
    // component locks. Measured in a real browser with focus on the button:
    // Arrow and PageDown moved a scrollable sheet 0px. With focus here:
    // ArrowDown 0→40px, PageDown 40→594px, Home back to 0.
    await waitFor(() => {
      expect(document.activeElement).toBe(scrollerOf(getByRole("dialog")));
    });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(() => (
      <AnimatedModal onClose={onClose} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes via the close button", async () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(() => (
      <AnimatedModal onClose={onClose} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    fireEvent.click(getByLabelText("Close"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("locks body scroll while open and restores it on close", async () => {
    const { unmount } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("restores focus to the trigger element when it unmounts", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <button type="button">Inside</button>
      </AnimatedModal>
    ));

    // Focus moves into the modal on open…
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));

    // …and returns to the trigger once the modal is gone.
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("reveals the panel to its final visible state under prefers-reduced-motion", async () => {
    const matchMediaSpy = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    vi.stubGlobal("matchMedia", matchMediaSpy);

    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    const dialog = getByRole("dialog");
    // Reduced motion short-circuits to the final visible state rather than
    // leaving the panel at its initial opacity-0 — the content must be visible.
    await waitFor(() => expect(dialog.style.opacity).toBe("1"));
    expect(dialog.style.transform).toBe("none");

    vi.unstubAllGlobals();
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

    // Still the first thing in the tab order, as before the restructure.
    expect(panel.querySelector("button")).toBe(close);

    // The scrollport must be focusable itself: it is where focus lands on open,
    // and `[tabindex]:not([tabindex="-1"])` is what puts it in the focus trap.
    expect(scroller.getAttribute("tabindex")).toBe("0");
    // Tabbing BACKWARDS scrolls a target to the top of the scrollport, which is
    // exactly where the close chip sits — reserve its 52px footprint so no
    // control is ever parked underneath it.
    expect(scroller.className).toContain("scroll-pt-14");
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
