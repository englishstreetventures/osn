import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import { AnimatedModal } from "../../src/components/AnimatedModal";

/**
 * The half of the sheet that only exists in an engine.
 *
 * `AnimatedModal.test.tsx` covers structure, wiring and the class contract.
 * None of what is below can be asserted there: jsdom implements no part of
 * `<dialog>`, so there is no top layer, no modality, no Escape, no focusing
 * steps and no focus restore — the four things this component stopped
 * hand-rolling when it moved onto `@shared/ui`'s `Modal`, and therefore the four
 * worth proving still happen.
 */
describe("the guest sheet, in a real engine", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.style.overflow = "";
    document.documentElement.style.scrollbarGutter = "";
    document.documentElement.style.overscrollBehavior = "";
  });

  /**
   * `close` is fired from an element task rather than a microtask, so a
   * `requestClose()` has not reached `Modal`'s listener yet when the next line
   * runs. A zero timeout is the smallest thing that lands after it.
   */
  const afterTheCloseEvent = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("opens modally, in the top layer", () => {
    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    // `:modal` is true only for a dialog opened with `showModal()` — an `open`
    // attribute alone does not match it. That is the whole difference between
    // this and the `fixed inset-0` div it replaced: the top layer paints above
    // every stacking context, so no ancestor `transform` can capture it and no
    // `z-index` has to be ranked against anything.
    expect(getByRole("dialog").matches(":modal")).toBe(true);
  });

  it.each([false, true])(
    "lands focus on the scroll container, so the keyboard can scroll the sheet (toolbar: %s)",
    (toolbar) => {
      const { getByRole } = render(() =>
        toolbar ? (
          <AnimatedModal
            onClose={() => {}}
            labelledBy="sheet-title"
            toolbar
            title={
              <h2 id="sheet-title" tabindex="-1">
                Mehndi
              </h2>
            }
            action={<button type="button">Give RSVP</button>}
          >
            <p>body</p>
          </AnimatedModal>
        ) : (
          <AnimatedModal onClose={() => {}} label="Event details">
            <p>body</p>
          </AnimatedModal>
        ),
      );

      // The dialog's focusing steps prefer the autofocus delegate over the
      // first tabbable descendant: the close button without a toolbar (a
      // sibling of the scrollport, so landing there leaves Arrow and PageDown
      // with nothing to move), and the bar's action with one. This is the
      // assertion the unit tier can only approximate by checking that the
      // attribute is present.
      const scroller = getByRole("dialog").lastElementChild;
      expect(document.activeElement).toBe(scroller);
    },
  );

  it("closes on Escape and says so, without the caller wiring a key handler", async () => {
    const onClose = vi.fn();
    render(() => (
      <AnimatedModal onClose={onClose} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    // A real Escape, driven through the browser, rather than a dispatched
    // `KeyboardEvent` (which a modal dialog ignores — the behaviour is the user
    // agent's) or `requestClose()` (which goes through the close-watcher
    // budget: without user activation a page gets one free watcher, so the
    // method quietly stops closing anything once a suite has opened a few
    // dialogs, and the failure lands on whichever test happens to run later).
    await userEvent.keyboard("{Escape}");
    await afterTheCloseEvent();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to whatever opened it", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Respond";
    document.body.append(trigger);
    trigger.focus();

    const { getByRole, unmount } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <button type="button">Inside</button>
      </AnimatedModal>
    ));
    expect(document.activeElement).not.toBe(trigger);

    // Unmounting while open is the shape every consumer has: the sheet lives
    // inside a `<Show>` that the caller clears. `Modal` closes the element in
    // its own cleanup rather than leaving the page inert, and closing a modal
    // dialog is what hands focus back.
    getByRole("dialog");
    unmount();
    await afterTheCloseEvent();

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("caps the panel at 480 real pixels, on both sides of the root-size step", () => {
    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    // The cap is `max-w-column-md`, not a rem step, and only an engine can tell
    // the two apart: this app steps its root font-size 16px → 17px at 1024px, so
    // a rem cap reads 480px here and 510px on a laptop while the class string
    // stays identical either way. Read as a resolved length rather than a
    // rendered width, because the viewport the test runs in may be narrower than
    // the cap — the cap is what is being asserted, not the layout under it.
    expect(getComputedStyle(getByRole("dialog")).maxWidth).toBe("480px");
  });
  /**
   * The invite's root carries `overflow-x: clip`, so the root's overflow is
   * not `visible` and a `<body>` value never reaches the viewport. The lock
   * has to be on the root itself, or a wheel or a touch on the sheet's
   * chrome or backdrop scrolls the invite behind it.
   */
  it("keeps the page behind it still while the sheet is open, and lets it scroll again after", async () => {
    const tall = document.createElement("div");
    tall.style.height = "4000px";
    document.body.append(tall);
    try {
      window.scrollTo(0, 0);
      const { getByRole, unmount } = render(() => (
        <AnimatedModal onClose={() => {}} label="Event details">
          <p>body</p>
        </AnimatedModal>
      ));

      await userEvent.wheel(getByRole("button", { name: "Close" }), { delta: { y: 600 } });
      await userEvent.wheel(getByRole("dialog"), { delta: { y: 600 } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(window.scrollY).toBe(0);
      // Nor does a drag that reaches the end of the sheet's own scroll chain
      // into the page, or rubber-band it, where an engine does either.
      expect(getComputedStyle(document.documentElement).overscrollBehaviorY).toBe("none");

      unmount();
      expect(document.documentElement.style.overflow).toBe("");
      expect(getComputedStyle(document.documentElement).overscrollBehaviorY).toBe("auto");
      await userEvent.wheel(tall, { delta: { y: 600 } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(window.scrollY).toBeGreaterThan(0);
    } finally {
      tall.remove();
      window.scrollTo(0, 0);
    }
  });

  /**
   * How much a `scrollbar-gutter: stable` gutter on the root narrows the page
   * in this engine, set the way the sheet's lock sets it. A classic
   * scrollbar's width where scrollbars are classic (Chromium on Linux, as in
   * CI); nothing where they overlay the page (macOS's default when no mouse
   * is connected), because an overlay scrollbar has no gutter.
   */
  const rootGutter = () => {
    const root = document.documentElement;
    const { overflow, scrollbarGutter } = root.style;
    const open = document.body.getBoundingClientRect().width;
    root.style.overflow = "hidden";
    root.style.scrollbarGutter = "stable";
    const locked = document.body.getBoundingClientRect().width;
    root.style.overflow = overflow;
    root.style.scrollbarGutter = scrollbarGutter;
    return open - locked;
  };

  /**
   * The gutter stands in for a classic scrollbar while the lock takes it away,
   * and has to go with the sheet: left behind, every page after the first
   * sheet is a scrollbar narrower for the rest of the visit.
   *
   * This Chromium never shows a scrollbar on the root — it reports
   * `innerWidth` equal to the root's `clientWidth` whatever the page holds —
   * so the sheet would never reserve a gutter here. The stub is that one
   * reading, a window 15px wider than its root as a classic scrollbar makes
   * it. The computed `scrollbar-gutter` shows the sheet set the gutter on the
   * root and took it away, on every platform. The width shows the page
   * narrowed by exactly the gutter this engine reserves at the root and got
   * all of it back: 15px where scrollbars are classic, nothing where they
   * overlay the page. Whether the engine's gutter matches the scrollbar it
   * replaces is the engine's to keep, and is not checked here.
   */
  it("gives the page its full width back when the sheet closes", () => {
    const root = document.documentElement;
    const width = () => document.body.getBoundingClientRect().width;
    const before = width();
    const gutter = rootGutter();
    vi.stubGlobal("innerWidth", root.clientWidth + 15);
    try {
      const { unmount } = render(() => (
        <AnimatedModal onClose={() => {}} label="Event details">
          <p>body</p>
        </AnimatedModal>
      ));
      expect({ width: width(), gutter: getComputedStyle(root).scrollbarGutter }).toEqual({
        width: before - gutter,
        gutter: "stable",
      });

      unmount();
      expect({ width: width(), gutter: getComputedStyle(root).scrollbarGutter }).toEqual({
        width: before,
        gutter: "auto",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * A page that shows no classic scrollbar has no width for the lock to take
   * away. On an invite shorter than the window, with classic scrollbars, a
   * gutter would only narrow the page as the sheet opens and widen it again
   * as it closes; where scrollbars overlay the page, as on a phone, there is
   * no gutter to reserve. This engine shows no scrollbar on the root, as above.
   */
  it("adds no gutter to a page that shows no scrollbar, so it does not narrow as the sheet opens", () => {
    const before = document.body.getBoundingClientRect().width;
    render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));
    expect({
      width: document.body.getBoundingClientRect().width,
      gutter: getComputedStyle(document.documentElement).scrollbarGutter,
    }).toEqual({ width: before, gutter: "auto" });
  });

  it("leaves the page where it was when the sheet closes", async () => {
    const tall = document.createElement("div");
    tall.style.height = "4000px";
    document.body.append(tall);
    try {
      window.scrollTo(0, 300);
      const { getByRole, unmount } = render(() => (
        <AnimatedModal onClose={() => {}} label="Event details">
          <p>body</p>
        </AnimatedModal>
      ));
      await userEvent.wheel(getByRole("dialog"), { delta: { y: 600 } });
      unmount();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(window.scrollY).toBe(300);
    } finally {
      tall.remove();
      window.scrollTo(0, 0);
    }
  });
});
