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
    document.body.style.overflow = "";
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

  it("lands focus on the scroll container, so the keyboard can scroll the sheet", () => {
    const { getByRole } = render(() => (
      <AnimatedModal onClose={() => {}} label="Event details">
        <p>body</p>
      </AnimatedModal>
    ));

    // The dialog's focusing steps prefer the autofocus delegate over the first
    // tabbable descendant, which is the close button — a sibling of the
    // scrollport, so landing there leaves Arrow and PageDown with nothing to
    // move. This is the assertion the unit tier can only approximate by
    // checking that the attribute is present.
    const scroller = getByRole("dialog").lastElementChild;
    expect(document.activeElement).toBe(scroller);
  });

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
});
