/**
 * `Modal` is built on `<dialog>` + `showModal()`, and essentially everything
 * that makes that worth choosing is invisible to a DOM shim: the top layer, the
 * focus trap, background inertness, `::backdrop`, Escape handling. A happy-dom
 * assertion that the element exists would pass against a `<div>` with the same
 * class list.
 *
 * So these run in real Chromium, and they test the platform behaviour this
 * component exists to borrow rather than the markup it emits.
 */

import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import { Modal } from "../src/ui/modal";

import "./test-support/tailwind.css";

/**
 * Mount a modal whose `open` is driven by a signal, as a caller's would be, and
 * hand back THAT dialog rather than whichever one `document.querySelector`
 * reaches first.
 *
 * The distinction is not pedantry: a `showModal()` dialog is in the top layer,
 * so it is not removed by an `afterEach` that only empties the render container,
 * and a document-wide lookup silently returns the first survivor from an earlier
 * test. Five assertions here failed that way before the query was scoped —
 * every one of them reporting a fault in the component rather than in the test.
 */
function mount(props: { dismissable?: boolean } = {}) {
  const [open, setOpen] = createSignal(true);
  const result = render(() => (
    <Modal open={open()} onClose={() => setOpen(false)} label="Test dialog" {...props}>
      <button type="button">inside</button>
    </Modal>
  ));
  const el = result.container.querySelector("dialog");
  if (!el) throw new Error("no dialog rendered");
  return { ...result, open, setOpen, dialog: () => el };
}

describe("Modal", () => {
  it("opens modally rather than as an inline dialog", () => {
    // `open` alone means a non-modal dialog: no top layer, no focus trap, no
    // inert background. `matches(":modal")` is the only way to tell the two
    // apart, and it is the whole reason for using this element.
    const { dialog } = mount();
    expect(dialog().open).toBe(true);
    expect(dialog().matches(":modal")).toBe(true);
  });

  it("makes the page behind it inert", () => {
    // The platform's doing, not ours — but if the dialog were ever opened with
    // `show()` instead of `showModal()` this is what would silently regress,
    // and a user would find it by clicking a button that does nothing.
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.append(outside);

    mount();
    let clicked = false;
    outside.addEventListener("click", () => (clicked = true));
    outside.click();

    // `.click()` dispatches directly and bypasses hit-testing, so inertness
    // shows up as the element being unreachable rather than as a swallowed
    // event: nothing outside the dialog can hold focus while it is open.
    outside.focus();
    expect(document.activeElement).not.toBe(outside);
    expect(clicked).toBe(true);

    outside.remove();
  });

  it("moves focus into the dialog when it opens", () => {
    const { getByText, dialog } = mount();
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(getByText("inside")).toBeTruthy();
  });

  it("tells the caller when the element closes itself, so `open` cannot desync", async () => {
    // The failure this guards: the dialog closes on Escape whether or not
    // anyone is listening. A caller that only clears `open` in its own button
    // handler is then left with `open === true` against a closed dialog, and
    // the next attempt to open does nothing at all.
    //
    // Two things this test had to learn the hard way. A *synthetic* Escape
    // keydown does not close a dialog — dispatched events do not run the UA's
    // default action — so `close()` stands in for it; that is the same code
    // path Escape reaches, and the assertion is about what the component does
    // once the element has closed. And `close` is fired in a queued task, not
    // synchronously, so the assertion has to yield first. Read synchronously it
    // reports a desync that is not there.
    const { open, dialog } = mount();
    dialog().close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(open()).toBe(false);
  });

  it("reopens after closing, rather than throwing", async () => {
    // `showModal()` on an already-open dialog throws `InvalidStateError`, so the
    // effect is guarded on the element's own state. This is the round trip that
    // would surface a wrong guard.
    //
    // The wait is not incidental: closing is deferred until the exit animation
    // finishes, so `open` is still true on the line after `setOpen(false)`. A
    // reopen DURING that window is a different claim, and it has its own test
    // under "Modal — the exit".
    const { setOpen, dialog } = mount();
    setOpen(false);
    while (dialog().open) await new Promise((r) => requestAnimationFrame(r));

    setOpen(true);
    expect(dialog().matches(":modal")).toBe(true);
  });

  it("closes when the backdrop is clicked, but not when its own padding is", () => {
    const { open, dialog } = mount();
    const box = dialog().getBoundingClientRect();

    // Inside the dialog's box, on its padding — a click that targets the dialog
    // element itself but is not the backdrop. The naive `target === currentTarget`
    // check closes here, which loses a user's work every time they miss a
    // control by a few pixels.
    dialog().dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: Math.round(box.left + 4),
        clientY: Math.round(box.top + 4),
      }),
    );
    expect(open()).toBe(true);

    // Outside the box: the backdrop.
    dialog().dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: Math.round(box.left - 20), clientY: 10 }),
    );
    expect(open()).toBe(false);
  });

  it("ignores backdrop clicks when `dismissable` is false", () => {
    const { open, dialog } = mount({ dismissable: false });
    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 2, clientY: 2 }));
    expect(open()).toBe(true);
  });

  it("paints a backdrop, through the `::backdrop` rule it injects", () => {
    const { dialog } = mount();
    const backdrop = getComputedStyle(dialog(), "::backdrop").backgroundColor;
    expect(backdrop).not.toBe("");
    expect(backdrop).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("carries an accessible name", () => {
    const { dialog } = mount();
    expect(dialog().getAttribute("aria-label")).toBe("Test dialog");
  });

  it("prefers `labelledBy` over `label`, so a visible heading cannot drift from it", () => {
    const { container } = render(() => (
      <>
        <h2 id="title">Delete profile</h2>
        <Modal open onClose={() => {}} label="ignored" labelledBy="title">
          body
        </Modal>
      </>
    ));
    const el = container.querySelector("dialog");
    expect(el?.getAttribute("aria-labelledby")).toBe("title");
    expect(el?.getAttribute("aria-label")).toBeNull();
  });

  it("needs no z-index, because the top layer is above every stacking context", () => {
    // The reason this component exists in the form it does. Nine hand-rolled
    // overlays in this repository are `position: fixed` in a portal, each one
    // an animated ancestor away from being trapped in a stacking context it
    // cannot escape — the bug that put cire's RSVP toast under the sheet it
    // fired beneath. A top-layer dialog cannot be captured that way.
    const trap = document.createElement("div");
    trap.style.transform = "translateZ(0)";
    trap.style.zIndex = "2147483647";
    trap.style.position = "relative";
    document.body.append(trap);

    render(
      () => (
        <Modal open onClose={() => {}} label="Trapped?">
          body
        </Modal>
      ),
      { container: trap },
    );

    const el = trap.querySelector("dialog") as HTMLDialogElement;
    expect(el.matches(":modal")).toBe(true);
    expect(getComputedStyle(el).zIndex).toBe("auto");

    // Rendered inside a transformed, stacking-context-creating ancestor and
    // still the topmost thing at its own centre.
    const box = el.getBoundingClientRect();
    const top = document.elementFromPoint(
      Math.round(box.left + box.width / 2),
      Math.round(box.top + box.height / 2),
    );
    expect(el.contains(top)).toBe(true);

    trap.remove();
  });
});

/**
 * The exit animation, which is the one thing about `<dialog>` the platform does
 * NOT hand you cross-browser.
 *
 * `close()` removes a dialog from the top layer immediately, so an exit
 * transition has nothing left to paint. The platform's own fix is the `overlay`
 * property with `transition-behavior: allow-discrete` — Chrome and Edge only,
 * unsupported in Safari and Firefox, which is most of the traffic on the
 * surface this component was built for. So `Modal` defers `close()` instead,
 * and these are the claims that deferral has to keep.
 *
 * Every one of them is invisible to a DOM shim: happy-dom parses no stylesheet,
 * runs no transition, and `getAnimations()` returns nothing there, so a unit
 * test of this would assert that a function was called and prove none of it.
 */
describe("Modal — the exit", () => {
  /** Wait until the dialog has actually left, or fail loudly rather than hang. */
  async function waitForClosed(dialog: HTMLDialogElement, budgetMs = 2000) {
    const deadline = performance.now() + budgetMs;
    while (dialog.open) {
      if (performance.now() > deadline) throw new Error("dialog never closed");
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  it("stays open, and in the top layer, while the exit runs", async () => {
    // The whole point. If `close()` were called on the spot, the element would
    // be out of the top layer before a single frame of the exit was painted.
    const { setOpen, dialog } = mount();
    setOpen(false);

    await new Promise((r) => requestAnimationFrame(r));
    expect(dialog().open).toBe(true);
    expect(dialog().matches(":modal")).toBe(true);
    expect(dialog().hasAttribute("data-closing")).toBe(true);

    await waitForClosed(dialog());
  });

  it("is actually animating while it waits, not merely sitting there", async () => {
    // `data-closing` present proves an attribute was set. This proves the
    // stylesheet the component injects turned that attribute into running
    // animations — which is what `close()` is being deferred FOR.
    const { setOpen, dialog } = mount();
    setOpen(false);
    await new Promise((r) => requestAnimationFrame(r));

    expect(dialog().getAnimations({ subtree: true }).length).toBeGreaterThan(0);
    await waitForClosed(dialog());
  });

  it("closes once the exit finishes, and tells the caller", async () => {
    const { open, setOpen, dialog } = mount();
    setOpen(false);
    await waitForClosed(dialog());

    expect(dialog().open).toBe(false);
    expect(dialog().hasAttribute("data-closing")).toBe(false);
    // `onClose` is wired to the element's own `close` event, so it fires from
    // the deferred call rather than from the caller's `setOpen`.
    expect(open()).toBe(false);
  });

  it("lets a reopen during the exit win, rather than the stale close landing", async () => {
    // The race this component would otherwise lose: somebody dismisses a sheet
    // and immediately reopens it. Without a token, the first close resolves a
    // moment later and shuts the dialog they just opened — a bug that only
    // appears under a fast hand and is untraceable when it does.
    const { setOpen, dialog } = mount();
    setOpen(false);
    await new Promise((r) => requestAnimationFrame(r));
    setOpen(true);

    expect(dialog().hasAttribute("data-closing")).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(dialog().open).toBe(true);
    expect(dialog().matches(":modal")).toBe(true);
  });

  it("animates in from a starting style rather than appearing at full opacity", async () => {
    // `@starting-style` is what gives the entry a from-state with no
    // JavaScript. Read on the frame it opens, the dialog should not yet be at
    // its resting values.
    const { dialog } = mount();
    const entering = dialog().getAnimations({ subtree: true });
    expect(entering.length).toBeGreaterThan(0);
  });

  it("waits out an animation this component did not start", async () => {
    // The claim that makes the hook animation-library-agnostic. An app driving
    // the panel with Motion One or the Web Animations API gets waited out the
    // same way, because what is awaited is whatever is RUNNING on the element
    // — not a transition this component knows the name of.
    const { setOpen, dialog } = mount();
    const slow = dialog().animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600 });

    setOpen(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(dialog().open).toBe(true);

    await slow.finished.catch(() => {});
    await waitForClosed(dialog());
    expect(dialog().open).toBe(false);
  });

  it("does not leave the page inert when it unmounts mid-exit", async () => {
    // An exit that is still being awaited when the component goes away must not
    // strand a `showModal()` dialog in the document: every click outside it
    // would be swallowed with nothing on screen to explain why.
    const { setOpen, unmount, dialog } = mount();
    const el = dialog();
    setOpen(false);
    await new Promise((r) => requestAnimationFrame(r));
    unmount();

    expect(el.open).toBe(false);
  });
});

describe("Modal under prefers-reduced-motion", () => {
  /** Typed accessor for the command registered in `vitest.config.ts`. */
  const emulate = (options: { reducedMotion?: "reduce" | "no-preference" }) =>
    (commands as unknown as { emulateMedia: (o: typeof options) => Promise<void> }).emulateMedia(
      options,
    );

  afterEach(async () => {
    // The browser context is shared across tests in this file, so a leaked
    // preference would rewrite every later assertion about motion.
    await emulate({ reducedMotion: "no-preference" });
  });

  it("collapses the choreography to 1ms rather than removing it", async () => {
    // Near-zero and not `none`, and the distinction is load-bearing rather than
    // stylistic: the exit is AWAITED — `closeWhenAnimationsFinish` waits on
    // `getAnimations({ subtree: true })` — and a transition that was never
    // started is one there is nothing to wait for. `transition: none` would
    // leave `getAnimations()` empty, which happens to work, but it takes the
    // close down a different code path from the one every other engine uses.
    await emulate({ reducedMotion: "reduce" });
    const { dialog } = mount();

    expect(getComputedStyle(dialog()).transitionDuration).toBe("0.001s");
  });

  it("still closes, and still tells the caller", async () => {
    // The assertion that matters more than the duration: whatever the motion
    // preference, the awaited exit has to resolve. A modal that never finished
    // closing under reduced motion would be a dialog nobody could dismiss.
    await emulate({ reducedMotion: "reduce" });
    const { dialog, open, setOpen } = mount();

    setOpen(false);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(dialog().open).toBe(false);
    expect(open()).toBe(false);
  });
});
