/**
 * How the Kobalte-backed overlays move: `Dialog`, `Popover`, `DropdownMenu` in
 * both looks, and `Tooltip`.
 *
 * Every number here is read back from the stylesheet (`--ui-dur-exit`,
 * `--ui-scale-enter`, Kobalte's origin variable), never written into the test,
 * so the guarantees hold whatever values the tokens carry: an exit is shorter
 * and nearer full size than its entry, every panel takes its scale from the
 * shared tokens, with both scale tokens at 1 every panel fades without
 * moving, the anchored panels grow from their trigger, a reader who
 * asked for reduced motion sees none, and closing a panel from the keyboard
 * still hands focus back to its trigger. Only a real engine resolves a
 * computed style or runs an animation, so none of it can sit in the unit tier.
 *
 * A tooltip's open and close timing is in `tooltip-timing.browser.test.tsx`,
 * its own file because Kobalte keeps the tooltips' warm-up state in module
 * scope, which a file of its own isolates.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../src/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../src/ui/popover";
import { Tooltip } from "../src/ui/tooltip";
import {
  emulateMedia,
  firstEvent,
  frames,
  rootMs,
  wait,
  watchAnimations,
  watchNodes,
  type Started,
} from "./test-support/motion";

import "./test-support/tailwind.css";

/** Past a tooltip's close and its skip window, so the next hover starts cold. */
const TOOLTIP_COOL = 450;

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  document.documentElement.style.removeProperty("--ui-scale-enter");
  document.documentElement.style.removeProperty("--ui-scale-exit");
  cleanup();
});

interface Overlay {
  name: string;
  view: () => JSX.Element;
  /** Open it as a pointer would. */
  open: () => Promise<void>;
  /** The trigger, for the keyboard. */
  trigger: () => HTMLElement;
  panel: () => HTMLElement | null;
  /** Close it, and wait until it has gone and the next open would start cold. */
  close: () => Promise<void>;
}

const away = () => screen.getByRole("button", { name: "Away" });

/** Laid out with room above and below, so no panel flips or clips. */
const frame = (overlay: () => JSX.Element) => () => (
  <div style={{ padding: "160px 40px" }}>
    {overlay()}
    <button type="button" style={{ "margin-left": "240px" }}>
      Away
    </button>
  </div>
);

async function escape(panel: () => HTMLElement | null) {
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(panel()).toBeNull(), { timeout: 2000 });
}

const button = (name: string) => () => screen.getByRole("button", { name });

const OVERLAYS: Record<"dialog" | "popover" | "menu" | "accent" | "tooltip", Overlay> = {
  dialog: {
    name: "Dialog",
    view: frame(() => (
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>A dialog</DialogTitle>
          <p>Its body.</p>
        </DialogContent>
      </Dialog>
    )),
    open: () => userEvent.click(button("Open dialog")()),
    trigger: button("Open dialog"),
    panel: () => document.querySelector<HTMLElement>('[role="dialog"]'),
    close: () => escape(OVERLAYS.dialog.panel),
  },
  popover: {
    name: "Popover",
    view: frame(() => (
      <Popover>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent>Its body.</PopoverContent>
      </Popover>
    )),
    open: () => userEvent.click(button("Open popover")()),
    trigger: button("Open popover"),
    panel: () => document.querySelector<HTMLElement>('[role="dialog"]'),
    close: () => escape(OVERLAYS.popover.panel),
  },
  menu: {
    name: "DropdownMenu, default",
    view: frame(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>First</DropdownMenuItem>
          <DropdownMenuItem>Second</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )),
    open: () => userEvent.click(button("Open menu")()),
    trigger: button("Open menu"),
    panel: () => document.querySelector<HTMLElement>('[role="menu"]'),
    close: () => escape(OVERLAYS.menu.panel),
  },
  accent: {
    name: "DropdownMenu, accent",
    view: frame(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent">
          <DropdownMenuItem>First</DropdownMenuItem>
          <DropdownMenuItem>Second</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )),
    open: () => userEvent.click(button("Open menu")()),
    trigger: button("Open menu"),
    panel: () => document.querySelector<HTMLElement>('[role="menu"]'),
    close: () => escape(OVERLAYS.accent.panel),
  },
  tooltip: {
    name: "Tooltip",
    view: frame(() => (
      <Tooltip text="What the badge means">
        <span>Badge</span>
      </Tooltip>
    )),
    open: () => userEvent.hover(screen.getByText("Badge")),
    trigger: () => screen.getByText("Badge"),
    // `aria-hidden`, so a role query skips it.
    panel: () => document.querySelector<HTMLElement>('[role="tooltip"]'),
    close: async () => {
      await userEvent.hover(away());
      await vi.waitFor(() => expect(OVERLAYS.tooltip.panel()).toBeNull(), { timeout: 2000 });
      await wait(TOOLTIP_COOL);
    },
  },
};

async function openPanel(overlay: Overlay): Promise<HTMLElement> {
  await overlay.open();
  const panel = await vi.waitFor(
    () => {
      const found = overlay.panel();
      if (!found) throw new Error(`${overlay.name}: no panel`);
      return found;
    },
    { timeout: 3000 },
  );
  await Promise.all(panel.getAnimations().map((a) => a.finished));
  await frames();
  return panel;
}

/** Open and close one overlay, and say what animated on its panel each way. */
async function cycle(overlay: Overlay): Promise<{ enter?: Started; exit?: Started }> {
  render(overlay.view);
  const watch = watchAnimations();
  const panel = await openPanel(overlay);
  await overlay.close();
  watch.stop();
  const on = (name: string) => watch.started.find((s) => s.target === panel && s.name === name);
  return { enter: on("ui-enter"), exit: on("ui-exit") };
}

const EXITING = [OVERLAYS.dialog, OVERLAYS.popover, OVERLAYS.menu];

describe("an overlay's exit", () => {
  for (const overlay of EXITING) {
    it(`${overlay.name}: runs for --ui-dur-exit, shorter than its entry`, async () => {
      const { enter, exit } = await cycle(overlay);
      expect(enter, "no entry animation").toBeDefined();
      expect(exit, "no exit animation").toBeDefined();
      expect(exit!.duration).toBe(rootMs("--ui-dur-exit"));
      expect(exit!.duration).toBeLessThan(enter!.duration);
    });

    it(`${overlay.name}: ends nearer full size than its entry starts`, async () => {
      const { enter, exit } = await cycle(overlay);
      const enterStep = 1 - Number(enter!.enterScale);
      const exitStep = 1 - Number(exit!.exitScale);
      expect(exitStep).toBeGreaterThan(0);
      expect(exitStep).toBeLessThan(enterStep);
    });
  }

  for (const overlay of [OVERLAYS.accent, OVERLAYS.tooltip]) {
    it(`${overlay.name}: runs none, so the panel goes at once`, async () => {
      const { enter, exit } = await cycle(overlay);
      expect(enter, "no entry animation").toBeDefined();
      expect(exit).toBeUndefined();
    });
  }
});

describe("an overlay's scale", () => {
  /** Values no component would choose, so one written into a component cannot match them. */
  function oddScales() {
    document.documentElement.style.setProperty("--ui-scale-enter", "0.5");
    document.documentElement.style.setProperty("--ui-scale-exit", "0.7");
  }

  for (const overlay of Object.values(OVERLAYS)) {
    it(`${overlay.name}: enters from --ui-scale-enter, not a number of its own`, async () => {
      oddScales();
      const { enter } = await cycle(overlay);
      expect(enter!.enterScale).toBe("0.5");
    });
  }

  for (const overlay of EXITING) {
    it(`${overlay.name}: leaves to --ui-scale-exit, not a number of its own`, async () => {
      oddScales();
      const { exit } = await cycle(overlay);
      expect(exit!.exitScale).toBe("0.7");
    });
  }
});

describe("a fade with no scale", () => {
  /**
   * The opt-in an app takes for overlays that fade without moving: both scale
   * tokens at 1. The cases above read the scale property each panel carries;
   * these read the computed `transform` itself, so a panel that also slides or
   * a keyframe that also translates fails here though it reads the tokens.
   */
  function fadeOnly() {
    document.documentElement.style.setProperty("--ui-scale-enter", "1");
    document.documentElement.style.setProperty("--ui-scale-exit", "1");
  }

  interface Held {
    transform: string;
    opacity: number;
  }

  /**
   * Hold the first `name` animation that starts on the panel at `at` (a
   * fraction of its run), read the panel's computed style there, then let the
   * run finish. Read inside the `animationstart` listener, while the panel is
   * certainly there: an 80ms exit unmounts it before a later read.
   */
  function holdAt(overlay: Overlay, name: "ui-enter" | "ui-exit", at: number) {
    let held: Held | undefined;
    const listen = (event: AnimationEvent) => {
      if (held || event.animationName !== name || event.target !== overlay.panel()) return;
      const panel = event.target as HTMLElement;
      const run = panel
        .getAnimations()
        .find((a) => a instanceof CSSAnimation && a.animationName === name);
      if (!run) return;
      run.pause();
      run.currentTime = Number(run.effect?.getComputedTiming().duration ?? 0) * at;
      const style = getComputedStyle(panel);
      held = { transform: style.transform, opacity: Number(style.opacity) };
      run.finish();
    };
    document.addEventListener("animationstart", listen, true);
    return {
      read: () => held,
      stop: () => document.removeEventListener("animationstart", listen, true),
    };
  }

  /** Open and close `overlay`, holding its `name` run at `at` of the way through. */
  async function heldFrame(overlay: Overlay, name: "ui-enter" | "ui-exit", at: number) {
    render(overlay.view);
    const hold = holdAt(overlay, name, at);
    await openPanel(overlay);
    await overlay.close();
    hold.stop();
    cleanup();
    const held = hold.read();
    expect(held, `${overlay.name}: no ${name} caught`).toBeDefined();
    return held!;
  }

  const identity = (transform: string) => new DOMMatrix(transform).isIdentity;

  // Each case runs a control first: the same hold with no token set catches a
  // scaled frame, so an identity after it is the tokens' doing and not a
  // missed frame.

  for (const overlay of Object.values(OVERLAYS)) {
    it(`${overlay.name}: fades in with no transform when both scale tokens are 1`, async () => {
      const scaled = await heldFrame(overlay, "ui-enter", 0);
      expect(identity(scaled.transform), `control entry held at ${scaled.transform}`).toBe(false);

      fadeOnly();
      const faded = await heldFrame(overlay, "ui-enter", 0);
      expect(identity(faded.transform), `entry held at ${faded.transform}`).toBe(true);
      expect(faded.opacity).toBe(0);
    });
  }

  for (const overlay of EXITING) {
    it(`${overlay.name}: fades out with no transform when both scale tokens are 1`, async () => {
      const scaled = await heldFrame(overlay, "ui-exit", 0.5);
      expect(identity(scaled.transform), `control exit held at ${scaled.transform}`).toBe(false);

      fadeOnly();
      const faded = await heldFrame(overlay, "ui-exit", 0.5);
      expect(identity(faded.transform), `exit held at ${faded.transform}`).toBe(true);
      expect(faded.opacity).toBeGreaterThan(0);
      expect(faded.opacity).toBeLessThan(1);
    });
  }
});

describe("an anchored panel's origin", () => {
  for (const overlay of [OVERLAYS.popover, OVERLAYS.tooltip, OVERLAYS.menu]) {
    it(`${overlay.name}: grows from its trigger, through Kobalte's origin variable`, async () => {
      render(overlay.view);
      const panel = await openPanel(overlay);
      // Kobalte writes keywords (`top center`) and a computed origin is
      // lengths, so resolve the variable on a probe of the panel's size inside
      // the same positioner and compare the two computed values.
      const positioner = panel.closest<HTMLElement>("[data-popper-positioner]");
      expect(positioner, "no Kobalte positioner").not.toBeNull();
      const style = getComputedStyle(panel);
      const probe = document.createElement("div");
      probe.style.cssText = `position:absolute;width:${style.width};height:${style.height};transform-origin:var(--kb-popper-content-transform-origin)`;
      positioner!.append(probe);
      const fromTrigger = getComputedStyle(probe).transformOrigin;
      probe.remove();
      expect(style.transformOrigin).toBe(fromTrigger);
      const centre = `${Number.parseFloat(style.width) / 2}px ${Number.parseFloat(style.height) / 2}px`;
      expect(style.transformOrigin).not.toBe(centre);
      await overlay.close();
    });
  }
});

describe("reduced motion", () => {
  for (const overlay of Object.values(OVERLAYS)) {
    it(`${overlay.name}: animates for a reader who has not asked for less`, async () => {
      // The control for the case below: its empty list means something only if
      // this one is not empty.
      const { enter } = await cycle(overlay);
      expect(enter).toBeDefined();
    });

    it(`${overlay.name}: runs no animation, opening or closing, under reduced motion`, async () => {
      await emulateMedia({ reducedMotion: "reduce" });
      render(overlay.view);
      const watch = watchAnimations();
      const panel = await openPanel(overlay);
      expect(panel.getAnimations()).toHaveLength(0);
      await overlay.close();
      watch.stop();
      // Every element, not just the panel: `Dialog`'s overlay fades too.
      expect(watch.started.map((s) => s.name)).toEqual([]);
    });
  }
});

describe("a tooltip leaving", () => {
  it("goes at once, with nothing animating on its way out", async () => {
    render(OVERLAYS.tooltip.view);
    const watch = watchAnimations();
    const panel = await openPanel(OVERLAYS.tooltip);
    const left = firstEvent(OVERLAYS.tooltip.trigger(), "pointerleave");
    const nodes = watchNodes('[role="tooltip"]');
    await userEvent.hover(away());
    await vi.waitFor(() => expect(OVERLAYS.tooltip.panel()).toBeNull(), {
      timeout: 2000,
      interval: 5,
    });
    nodes.stop();
    watch.stop();
    // Timed by the page's clock from the pointer leaving. The close is a 0ms
    // timer; Kobalte's default close delay would hold the panel 300ms.
    const gone = nodes.removed.find((s) => s.node === panel);
    expect(gone, "the panel was never removed").toBeDefined();
    expect(gone!.at - left()).toBeLessThan(150);
    expect(watch.started.filter((s) => s.name === "ui-exit")).toEqual([]);
    await wait(TOOLTIP_COOL);
  });
});

describe("closing from the keyboard", () => {
  for (const overlay of EXITING) {
    it(`${overlay.name}: hands focus back to the trigger after its exit`, async () => {
      render(overlay.view);
      overlay.trigger().focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(overlay.panel()).not.toBeNull(), { timeout: 3000 });
      await wait(200);
      await overlay.close();
      await frames();
      expect(document.activeElement).toBe(overlay.trigger());
    });
  }
});
