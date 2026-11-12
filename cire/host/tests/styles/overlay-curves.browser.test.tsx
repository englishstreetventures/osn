import { Modal } from "@shared/ui/ui/modal";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/ui/popover";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

// The shared overlays arrive on cire's one arriving curve and leave on their
// own (DESIGN.md §4). `Modal`'s rise and `animate-in` read the contract's
// `--ui-ease-out`, which this stylesheet maps onto `--ease-out`; `animate-out`
// reads `--ui-ease-exit`, which it leaves alone, and `Modal` leaves on CSS's
// `ease-in`. Only an engine resolves the variable chain and runs the
// animations, so this reads them back as they start.

afterEach(() => cleanup());

/** What `token` computes to as an easing, on a probe that holds only it. */
function easing(token: string): string {
  const probe = document.createElement("div");
  probe.style.animationTimingFunction = `var(${token})`;
  document.body.append(probe);
  const computed = getComputedStyle(probe).animationTimingFunction;
  probe.remove();
  return computed;
}

/** cire's arriving curve, and the contract's exit curve, which must differ. */
function curves() {
  const arriving = easing("--ease-out");
  const exit = easing("--ui-ease-exit");
  expect(arriving).toBe("cubic-bezier(0.23, 1, 0.32, 1)");
  expect(exit).not.toBe(arriving);
  return { arriving, exit };
}

describe("a popover", () => {
  it("arrives on --ease-out and leaves on --ui-ease-exit", async () => {
    const { arriving, exit } = curves();
    // The panel's curve, read as each animation starts: the exit runs 80ms
    // and the panel unmounts when it ends, so a read after the close races it.
    const started: { name: string; easing: string }[] = [];
    const listen = (event: AnimationEvent) => {
      const target = event.target as HTMLElement;
      if (target.getAttribute("role") !== "dialog") return;
      started.push({
        name: event.animationName,
        easing: getComputedStyle(target).animationTimingFunction,
      });
    };
    document.addEventListener("animationstart", listen, true);
    try {
      render(() => (
        <Popover>
          <PopoverTrigger>Diet</PopoverTrigger>
          <PopoverContent>Vegetarian</PopoverContent>
        </Popover>
      ));
      await userEvent.click(await screen.findByRole("button", { name: "Diet" }));
      const panel = await screen.findByRole("dialog");
      await Promise.all(panel.getAnimations().map((a) => a.finished));
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(panel.isConnected).toBe(false));
    } finally {
      document.removeEventListener("animationstart", listen, true);
    }
    expect(started).toEqual([
      { name: "ui-enter", easing: arriving },
      { name: "ui-exit", easing: exit },
    ]);
  });
});

describe("a modal", () => {
  it("rises on --ease-out and leaves on ease-in", async () => {
    const { arriving } = curves();
    // Ten times the desk pace (2s in, 1.5s out), so a slow runner still finds
    // each transition running when it reads it.
    const root = document.documentElement.style;
    root.setProperty("--motion-scale", "10");
    try {
      const [open, setOpen] = createSignal(true);
      render(() => (
        <Modal open={open()} onClose={() => setOpen(false)} label="Remove guest">
          <p>Inside</p>
        </Modal>
      ));
      const dialog = await screen.findByRole("dialog", { name: "Remove guest" });
      await new Promise(requestAnimationFrame);
      /** The curve of each transition running on the dialog itself. */
      const running = () =>
        dialog
          .getAnimations()
          .map((a) => ({
            property: (a as CSSTransition).transitionProperty,
            easing: a.effect!.getTiming().easing,
          }))
          .toSorted((a, b) => a.property.localeCompare(b.property));
      expect(running()).toEqual([
        { property: "opacity", easing: arriving },
        { property: "transform", easing: arriving },
      ]);
      for (const transition of dialog.getAnimations()) transition.finish();
      setOpen(false);
      expect(running()).toEqual([
        { property: "opacity", easing: "ease-in" },
        { property: "transform", easing: "ease-in" },
      ]);
      for (const transition of dialog.getAnimations()) transition.finish();
    } finally {
      root.removeProperty("--motion-scale");
    }
  });
});
