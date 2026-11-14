/**
 * How the Kobalte-backed overlays move: `Dialog`, `Popover`, `DropdownMenu` in
 * both looks, and `Tooltip`.
 *
 * Every number here is read back from the stylesheet (`--ui-dur-exit`,
 * `--ui-scale-enter`, Kobalte's origin variable), never written into the test,
 * so the guarantees hold whatever values the tokens carry: an exit is shorter
 * and nearer full size than its entry, every panel takes its scale from the
 * shared tokens, an exit runs on `--ui-ease-exit` and an entry on
 * `--ui-ease-out` and neither follows the other's token, with both scale
 * tokens at 1 every panel fades without moving, the anchored panels grow
 * from their trigger, a reader who
 * asked for reduced motion sees none, and closing a panel from the keyboard
 * still hands focus back to its trigger. `Dialog` as a sheet below `md` slides
 * instead: up from its own height on `--ui-dur-slow`, down on `--ui-dur-base`,
 * both on `--ui-ease-sheet`, its scrim fading on the same pace, turning round
 * from wherever it is when closed or reopened part-way, and still the card at
 * `md` and up. Under reduced motion the sheet fades in and out with its scrim
 * on that pace, with no transform on any frame. One guarantee depends on the values:
 * with nothing set, an exit runs the curve its entry does, which keeps the
 * two curve tokens' defaults equal. Only a real engine resolves a
 * computed style or runs an animation, so none of it can sit in the unit tier.
 *
 * A tooltip's open and close timing is in `tooltip-timing.browser.test.tsx`,
 * its own file because Kobalte keeps the tooltips' warm-up state in module
 * scope, which a file of its own isolates.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

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
  rootEasing,
  rootMs,
  wait,
  watchAnimations,
  watchNodes,
  watchTransitions,
  type Started,
} from "./test-support/motion";

import "./test-support/tailwind.css";

/** Past a tooltip's close and its skip window, so the next hover starts cold. */
const TOOLTIP_COOL = 450;

/** The width every case runs at unless it names one, put back after a case that changes it. */
const home = { width: innerWidth, height: innerHeight };

async function atWidth(width: number, height = 800) {
  await page.viewport(width, height);
  await vi.waitFor(() => {
    if (innerWidth !== width) throw new Error("viewport not resized yet");
  });
}

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  for (const token of [
    "--ui-scale-enter",
    "--ui-scale-exit",
    "--ui-ease-out",
    "--ui-ease-exit",
    "--ui-dur-slow",
    "--ui-dur-base",
    "--ui-ease-sheet",
  ])
    document.documentElement.style.removeProperty(token);
  cleanup();
  if (innerWidth !== home.width) await atWidth(home.width, home.height);
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
  /** The viewport width it runs at, where its shape depends on one. */
  width?: number;
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

/**
 * Open and close one overlay, and say what ran on its panel each way: the
 * card's `ui-enter` and `ui-exit`, or a sheet's `ui-sheet-enter` and
 * `ui-sheet-exit`.
 */
async function cycle(overlay: Overlay): Promise<{ enter?: Started; exit?: Started }> {
  if (overlay.width) await atWidth(overlay.width);
  render(overlay.view);
  const watch = watchAnimations();
  const panel = await openPanel(overlay);
  await overlay.close();
  watch.stop();
  const on = (...names: string[]) =>
    watch.started.find((s) => s.target === panel && names.includes(s.name));
  return { enter: on("ui-enter", "ui-sheet-enter"), exit: on("ui-exit", "ui-sheet-exit") };
}

/**
 * `Dialog` as the bottom sheet pulse's share dialog, Musubi's dialogs and
 * `@osn/auth-ui`'s step-up take, at a phone width so its `max-md:` classes
 * apply. It slides rather than fades, so "a sheet's slide" below holds its
 * motion, its reduced-motion fade included.
 */
const DIALOG_SHEET: Overlay = {
  ...OVERLAYS.dialog,
  name: "Dialog, sheet",
  width: 390,
  view: frame(() => (
    <Dialog>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent presentation="sheet">
        <DialogTitle>A dialog</DialogTitle>
        <p>Its body.</p>
      </DialogContent>
    </Dialog>
  )),
};

/** The same sheet at a desktop width, where it is the card and moves as the card does. */
const DIALOG_SHEET_WIDE: Overlay = {
  ...DIALOG_SHEET,
  name: "Dialog, sheet at 1440px",
  width: 1440,
};

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

describe("an overlay's curve", () => {
  /**
   * A curve neither token carries, so a panel running it can only have read it
   * from the token it was set on. `--ui-ease-out` times every arrival, and an
   * app that maps it must not move its overlays' exits too.
   */
  const ODD_CURVE = "cubic-bezier(0.5, 0, 0.5, 1)";

  for (const overlay of EXITING) {
    // With both tokens on one curve, this case cannot tell which token the
    // exit reads; the two cases after it can. It holds the two defaults
    // equal, so a contract that gives exits a curve of their own fails here.
    it(`${overlay.name}: with nothing set, leaves on the curve it arrives on`, async () => {
      const { enter, exit } = await cycle(overlay);
      expect(exit!.easing, "the exit's default curve is not the entry's").toBe(enter!.easing);
    });

    it(`${overlay.name}: keeps its exit curve when only --ui-ease-out is set`, async () => {
      const exitCurve = rootEasing("--ui-ease-exit");
      document.documentElement.style.setProperty("--ui-ease-out", ODD_CURVE);
      const arrival = rootEasing("--ui-ease-out");
      expect(arrival).not.toBe(exitCurve);
      const { enter, exit } = await cycle(overlay);
      expect(enter!.easing, "the entry did not read --ui-ease-out").toBe(arrival);
      expect(exit!.easing, "the exit followed --ui-ease-out").not.toBe(arrival);
      expect(exit!.easing).toBe(exitCurve);
    });

    it(`${overlay.name}: follows --ui-ease-exit, and its entry does not`, async () => {
      const arrival = rootEasing("--ui-ease-out");
      document.documentElement.style.setProperty("--ui-ease-exit", ODD_CURVE);
      const exitCurve = rootEasing("--ui-ease-exit");
      expect(exitCurve).not.toBe(arrival);
      const { enter, exit } = await cycle(overlay);
      expect(exit!.easing, "the exit did not read --ui-ease-exit").toBe(exitCurve);
      expect(enter!.easing, "the entry followed --ui-ease-exit").toBe(arrival);
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
    if (overlay.width) await atWidth(overlay.width);
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
  for (const overlay of [...Object.values(OVERLAYS), DIALOG_SHEET_WIDE]) {
    it(`${overlay.name}: animates for a reader who has not asked for less`, async () => {
      // The control for the case below: its empty list means something only if
      // this one is not empty.
      const { enter } = await cycle(overlay);
      expect(enter).toBeDefined();
    });

    it(`${overlay.name}: runs no animation, opening or closing, under reduced motion`, async () => {
      if (overlay.width) await atWidth(overlay.width);
      await emulateMedia({ reducedMotion: "reduce" });
      render(overlay.view);
      const watch = watchAnimations();
      const moved = watchTransitions();
      const panel = await openPanel(overlay);
      expect(panel.getAnimations()).toHaveLength(0);
      await overlay.close();
      watch.stop();
      moved.stop();
      // Every element, not just the panel: `Dialog`'s overlay fades too.
      expect(watch.started.map((s) => s.name)).toEqual([]);
      // A sheet's slide and its reduced-motion fade are transitions, not
      // keyframes, and neither may reach the card.
      const slid = moved.ran.filter((r) =>
        ["transform", "translate", "opacity"].includes(r.property),
      );
      expect(slid.map((r) => `${r.target.tagName} ${r.property}`)).toEqual([]);
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

describe("a sheet's slide", () => {
  /** A sheet opened and closed through its `open` prop, so a case can act while a run is held. */
  function renderSheet(): (open: boolean) => void {
    const [open, setOpen] = createSignal(false);
    render(() => (
      <div>
        <button type="button">Before</button>
        <Dialog open={open()} onOpenChange={setOpen}>
          <DialogContent presentation="sheet">
            <DialogTitle>A sheet</DialogTitle>
            <p>Its body.</p>
          </DialogContent>
        </Dialog>
      </div>
    ));
    return setOpen;
  }

  const sheetPanel = () => document.querySelector<HTMLElement>('[role="dialog"]');

  /** The scrim, which Kobalte draws just before the panel. */
  function scrimOf(panel: HTMLElement): HTMLElement {
    const scrim = panel.previousElementSibling;
    if (!(scrim instanceof HTMLElement) || getComputedStyle(scrim).position !== "fixed") {
      throw new Error("no scrim before the sheet");
    }
    return scrim;
  }

  interface SheetFrame {
    /** How far below its resting place the panel sits: its bottom edge less the window's. */
    shift: number;
    height: number;
    matrix: DOMMatrix;
    opacity: number;
    scrim: number;
  }

  function readSheet(panel: HTMLElement): SheetFrame {
    const box = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      shift: box.bottom - innerHeight,
      height: box.height,
      matrix: new DOMMatrix(style.transform === "none" ? undefined : style.transform),
      opacity: Number(style.opacity),
      scrim: Number(getComputedStyle(scrimOf(panel)).opacity),
    };
  }

  /** A transform that moves the panel up or down and does nothing else. */
  const movesOnly = (m: DOMMatrix) => m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0;

  /** Where to hold each run, in milliseconds from its start. */
  type Seek = (run: Animation) => number;
  const fraction =
    (at: number): Seek =>
    (run) =>
      Number(run.effect?.getComputedTiming().duration ?? 0) * at;
  const after =
    (msIn: number): Seek =>
    () =>
      msIn;

  interface Caught {
    panel: HTMLElement;
    frame: SheetFrame;
    runs: Animation[];
  }

  /**
   * The moment `name` starts on the panel, pause every run on the panel and
   * its scrim, transitions and keyframes alike, at `seek`, and read the frame.
   * It all happens inside the `animationstart` listener, before the browser
   * draws the run, so the read is of the held seen.
   */
  function holdSheet(name: "ui-sheet-enter" | "ui-sheet-exit", seek: Seek) {
    let caught: Caught | undefined;
    const listen = (event: AnimationEvent) => {
      if (caught || event.animationName !== name) return;
      const panel = event.target;
      if (!(panel instanceof HTMLElement) || panel.getAttribute("role") !== "dialog") return;
      const runs = [...panel.getAnimations(), ...scrimOf(panel).getAnimations()];
      for (const run of runs) {
        run.pause();
        const end = Number(run.effect?.getComputedTiming().endTime ?? 0);
        run.currentTime = Math.min(seek(run), end);
      }
      caught = { panel, frame: readSheet(panel), runs };
      document.removeEventListener("animationstart", listen, true);
    };
    document.addEventListener("animationstart", listen, true);
    return {
      caught: () =>
        vi.waitFor(
          () => {
            if (!caught) throw new Error(`no ${name} caught`);
            return caught;
          },
          { timeout: 3000 },
        ),
      stop: () => document.removeEventListener("animationstart", listen, true),
    };
  }

  /** Let every held run go to its end. */
  function release(runs: Animation[]) {
    for (const run of runs) if (run.playState !== "idle") run.finish();
  }

  /** Every run on the panel and its scrim, finished. */
  async function settled(panel: HTMLElement) {
    const runs = [...panel.getAnimations(), ...scrimOf(panel).getAnimations()];
    await Promise.all(runs.map((run) => run.finished.catch(() => undefined)));
    await frames();
  }

  async function openSheet(set: (open: boolean) => void): Promise<HTMLElement> {
    set(true);
    const panel = await vi.waitFor(
      () => {
        const found = sheetPanel();
        if (!found) throw new Error("no sheet");
        return found;
      },
      { timeout: 3000 },
    );
    await settled(panel);
    return panel;
  }

  async function gone() {
    await vi.waitFor(() => expect(sheetPanel()).toBeNull(), { timeout: 3000 });
  }

  /** What one open and close moved, on the panel and on the scrim. */
  async function pace() {
    const set = renderSheet();
    const moved = watchTransitions();
    const runs = watchAnimations();
    const panel = await openSheet(set);
    const scrim = scrimOf(panel);
    set(false);
    await gone();
    moved.stop();
    runs.stop();
    const on = (target: Element, property: string) =>
      moved.ran.filter((r) => r.target === target && r.property === property);
    const run = (name: string) => runs.started.find((s) => s.target === panel && s.name === name);
    return {
      panel: on(panel, "transform"),
      scrim: on(scrim, "opacity"),
      enterRun: run("ui-sheet-enter"),
      exitRun: run("ui-sheet-exit"),
    };
  }

  beforeEach(async () => {
    await atWidth(390);
  });

  it("rises from its own height below the bottom edge, at full opacity, and settles", async () => {
    const set = renderSheet();
    const hold = holdSheet("ui-sheet-enter", fraction(0));
    set(true);
    const { panel, frame: seen, runs } = await hold.caught();
    expect(seen.height).toBeGreaterThan(0);
    expect(Math.abs(seen.shift - seen.height), `held ${seen.shift}px down`).toBeLessThanOrEqual(1);
    expect(movesOnly(seen.matrix), `held at ${seen.matrix}`).toBe(true);
    expect(seen.opacity).toBe(1);
    release(runs);
    await settled(panel);
    expect(Math.abs(readSheet(panel).shift)).toBeLessThanOrEqual(0.5);
  });

  it("falls part-way at half its exit, at full opacity", async () => {
    const set = renderSheet();
    await openSheet(set);
    const hold = holdSheet("ui-sheet-exit", fraction(0.5));
    set(false);
    const { frame: seen, runs } = await hold.caught();
    expect(seen.shift).toBeGreaterThan(1);
    expect(seen.shift).toBeLessThan(seen.height - 1);
    expect(movesOnly(seen.matrix), `held at ${seen.matrix}`).toBe(true);
    expect(seen.opacity).toBe(1);
    release(runs);
    await gone();
  });

  it("rises on --ui-dur-slow and falls on --ui-dur-base, both on --ui-ease-sheet", async () => {
    const { panel, enterRun, exitRun } = await pace();
    expect(panel, "the panel's transform did not transition both ways").toHaveLength(2);
    const [rise, fall] = panel as [(typeof panel)[0], (typeof panel)[0]];
    expect(rise.duration).toBe(rootMs("--ui-dur-slow"));
    expect(fall.duration).toBe(rootMs("--ui-dur-base"));
    const curve = rootEasing("--ui-ease-sheet");
    expect(rise.easing).toBe(curve);
    expect(fall.easing).toBe(curve);
    // Kobalte keeps the panel mounted for the length of its keyframe run.
    expect(enterRun?.duration).toBe(rise.duration);
    expect(exitRun?.duration).toBe(fall.duration);
  });

  it("follows --ui-dur-slow, --ui-dur-base and --ui-ease-sheet, not numbers of its own", async () => {
    const root = document.documentElement.style;
    root.setProperty("--ui-dur-slow", "410ms");
    root.setProperty("--ui-dur-base", "170ms");
    root.setProperty("--ui-ease-sheet", "cubic-bezier(0.5, 0, 0.5, 1)");
    const curve = rootEasing("--ui-ease-sheet");
    const { panel, scrim, exitRun } = await pace();
    expect(panel.map((r) => r.duration)).toEqual([410, 170]);
    expect(scrim.map((r) => r.duration)).toEqual([410, 170]);
    expect([...panel, ...scrim].every((r) => r.easing === curve)).toBe(true);
    expect(exitRun?.duration).toBe(170);
  });

  it("falls faster than it rises", async () => {
    const { panel } = await pace();
    expect(panel[1]!.duration).toBeLessThan(panel[0]!.duration);
  });

  it("fades its scrim in and out on the panel's pace, from 0", async () => {
    const { panel, scrim } = await pace();
    expect(scrim.map((r) => [r.duration, r.easing])).toEqual(
      panel.map((r) => [r.duration, r.easing]),
    );

    const set = renderSheet();
    const hold = holdSheet("ui-sheet-enter", fraction(0));
    set(true);
    const { frame: seen, runs } = await hold.caught();
    expect(seen.scrim).toBe(0);
    release(runs);
  });

  it("slides the same way whatever the scale tokens hold", async () => {
    const entryFrame = async () => {
      const set = renderSheet();
      const hold = holdSheet("ui-sheet-enter", fraction(0));
      set(true);
      const { frame: seen, runs } = await hold.caught();
      release(runs);
      cleanup();
      return seen;
    };
    // Unset, as pulse leaves them: 0.96 and 0.98.
    const unset = await entryFrame();
    // Both at 1, as Musubi maps them.
    document.documentElement.style.setProperty("--ui-scale-enter", "1");
    document.documentElement.style.setProperty("--ui-scale-exit", "1");
    const one = await entryFrame();
    for (const seen of [unset, one]) {
      expect(movesOnly(seen.matrix), `held at ${seen.matrix}`).toBe(true);
      expect(Math.abs(seen.shift - seen.height)).toBeLessThanOrEqual(1);
    }
  });

  it("rises from its own height at 767px, the last width below md", async () => {
    await atWidth(767);
    const set = renderSheet();
    const hold = holdSheet("ui-sheet-enter", fraction(0));
    set(true);
    const { panel, frame: seen, runs } = await hold.caught();
    expect(Math.abs(seen.shift - seen.height), `held ${seen.shift}px down`).toBeLessThanOrEqual(1);
    expect(movesOnly(seen.matrix), `held at ${seen.matrix}`).toBe(true);
    release(runs);
    await settled(panel);
  });

  for (const width of [768, 1440]) {
    it(`is the card at ${width}px: the card's entry, and no slide`, async () => {
      await atWidth(width);
      const set = renderSheet();
      const moved = watchTransitions();
      const runs = watchAnimations();
      const panel = await openSheet(set);
      const scrim = scrimOf(panel);
      set(false);
      await gone();
      moved.stop();
      runs.stop();
      const enter = runs.started.find((s) => s.target === panel && s.name === "ui-enter");
      expect(enter, "no card entry").toBeDefined();
      expect(enter!.duration).toBe(rootMs("--ui-dur-fast"));
      expect(enter!.easing).toBe(rootEasing("--ui-ease-out"));
      expect(enter!.enterScale).toBe(
        getComputedStyle(document.documentElement).getPropertyValue("--ui-scale-enter").trim() ||
          "0.96",
      );
      const slid = moved.ran.filter(
        (r) => r.target === panel && ["transform", "translate"].includes(r.property),
      );
      expect(slid).toEqual([]);
      // The scrim fades with the card's runs too, not the sheet's transition.
      const scrimRuns = runs.started.filter((s) => s.target === scrim).map((s) => s.name);
      expect(scrimRuns).toEqual(["ui-enter", "ui-exit"]);
      expect(moved.ran.filter((r) => r.target === scrim && r.property === "opacity")).toEqual([]);
    });
  }

  it("fades a centred Dialog's scrim with the card's runs at 390px", async () => {
    render(OVERLAYS.dialog.view);
    const runs = watchAnimations();
    const panel = await openPanel(OVERLAYS.dialog);
    const scrim = scrimOf(panel);
    await OVERLAYS.dialog.close();
    runs.stop();
    const scrimRuns = runs.started.filter((s) => s.target === scrim).map((s) => s.name);
    expect(scrimRuns).toEqual(["ui-enter", "ui-exit"]);
  });

  it("hands focus back to what had it, after the slide out", async () => {
    render(DIALOG_SHEET.view);
    DIALOG_SHEET.trigger().focus();
    await userEvent.keyboard("{Enter}");
    const panel = await vi.waitFor(
      () => {
        const found = DIALOG_SHEET.panel();
        if (!found) throw new Error("no sheet");
        return found;
      },
      { timeout: 3000 },
    );
    await settled(panel);
    await DIALOG_SHEET.close();
    await frames();
    expect(document.activeElement).toBe(DIALOG_SHEET.trigger());
  });

  it("closed 100ms into its rise, turns round from where it had got to", async () => {
    const set = renderSheet();
    const rising = holdSheet("ui-sheet-enter", after(100));
    set(true);
    const held = await rising.caught();
    expect(held.frame.shift).toBeGreaterThan(1);
    expect(held.frame.shift).toBeLessThan(held.frame.height - 1);
    const falling = holdSheet("ui-sheet-exit", fraction(0));
    set(false);
    const turned = await falling.caught();
    expect(Math.abs(turned.frame.shift - held.frame.shift)).toBeLessThanOrEqual(1);
    expect(Math.abs(turned.frame.scrim - held.frame.scrim)).toBeLessThanOrEqual(0.02);
    release([...held.runs, ...turned.runs]);
    await gone();
  });

  it("slides out on a second close as on the first", async () => {
    const set = renderSheet();
    await openSheet(set);
    set(false);
    await gone();
    await openSheet(set);
    const moved = watchTransitions();
    const hold = holdSheet("ui-sheet-exit", fraction(0.5));
    set(false);
    const { panel, frame: seen, runs } = await hold.caught();
    moved.stop();
    expect(panel.isConnected).toBe(true);
    expect(seen.shift).toBeGreaterThan(1);
    expect(moved.ran.some((r) => r.target === panel && r.property === "transform")).toBe(true);
    release(runs);
    await gone();
  });

  it("reopened half-way down, rises from where it had got to", async () => {
    const set = renderSheet();
    await openSheet(set);
    const falling = holdSheet("ui-sheet-exit", fraction(0.5));
    set(false);
    const held = await falling.caught();
    const rising = holdSheet("ui-sheet-enter", fraction(0));
    set(true);
    const turned = await rising.caught();
    expect(turned.panel).toBe(held.panel);
    expect(Math.abs(turned.frame.shift - held.frame.shift)).toBeLessThanOrEqual(1);
    release([...held.runs, ...turned.runs]);
    await settled(turned.panel);
    expect(Math.abs(readSheet(turned.panel).shift)).toBeLessThanOrEqual(0.5);
    expect(turned.panel.hasAttribute("data-expanded")).toBe(true);
  });

  it("carried from 1440px to 390px while open, moves to the bottom edge without sliding", async () => {
    await atWidth(1440);
    const set = renderSheet();
    const panel = await openSheet(set);
    const moved = watchTransitions();
    await atWidth(390);
    await frames();
    moved.stop();
    const slid = moved.ran.filter(
      (r) => r.target === panel && ["transform", "translate"].includes(r.property),
    );
    expect(slid).toEqual([]);
    expect(Math.abs(readSheet(panel).shift)).toBeLessThanOrEqual(0.5);
  });

  describe("under reduced motion", () => {
    beforeEach(async () => {
      await emulateMedia({ reducedMotion: "reduce" });
    });

    interface Painted {
      transform: string;
      shift: number;
      opacity: number;
      /** `NaN` on a frame where the scrim has already gone. */
      scrim: number;
    }

    /** Read the sheet and its scrim on every frame drawn until `stop()`. */
    function everyFrame(): { seen: Painted[]; stop: () => void } {
      const seen: Painted[] = [];
      let on = true;
      const step = () => {
        if (!on) return;
        const panel = sheetPanel();
        if (panel) {
          const style = getComputedStyle(panel);
          const scrim = panel.previousElementSibling;
          seen.push({
            transform: style.transform,
            shift: panel.getBoundingClientRect().bottom - innerHeight,
            opacity: Number(style.opacity),
            scrim:
              scrim instanceof HTMLElement ? Number(getComputedStyle(scrim).opacity) : Number.NaN,
          });
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return { seen, stop: () => (on = false) };
    }

    const partway = (value: number) => value > 0 && value < 1;

    it("fades in and out with its scrim, with no transform on any frame", async () => {
      const set = renderSheet();
      const opening = everyFrame();
      await openSheet(set);
      opening.stop();
      const closing = everyFrame();
      set(false);
      await gone();
      closing.stop();
      for (const [way, seen] of [
        ["opening", opening.seen],
        ["closing", closing.seen],
      ] as const) {
        expect(seen.length, `${way}: no frame read`).toBeGreaterThan(2);
        expect(
          seen.filter((f) => f.transform !== "none").map((f) => f.transform),
          `${way}: a frame with a transform`,
        ).toEqual([]);
        expect(
          seen.filter((f) => Math.abs(f.shift) > 0.5).map((f) => f.shift),
          `${way}: a frame off the bottom edge`,
        ).toEqual([]);
        expect(
          seen.some((f) => partway(f.opacity)),
          `${way}: the sheet never part-faded`,
        ).toBe(true);
        expect(
          seen.some((f) => partway(f.scrim)),
          `${way}: the scrim never part-faded`,
        ).toBe(true);
      }
    });

    it("starts clear and in place, its scrim clear too", async () => {
      const set = renderSheet();
      const hold = holdSheet("ui-sheet-enter", fraction(0));
      set(true);
      const { panel, frame: seen, runs } = await hold.caught();
      expect(Math.abs(seen.shift), `held ${seen.shift}px down`).toBeLessThanOrEqual(0.5);
      expect(seen.opacity).toBe(0);
      expect(seen.scrim).toBe(0);
      release(runs);
      await settled(panel);
      expect(readSheet(panel).opacity).toBe(1);
    });

    it("hands focus back to what had it, after the fade out", async () => {
      render(DIALOG_SHEET.view);
      DIALOG_SHEET.trigger().focus();
      await userEvent.keyboard("{Enter}");
      const panel = await vi.waitFor(
        () => {
          const found = DIALOG_SHEET.panel();
          if (!found) throw new Error("no sheet");
          return found;
        },
        { timeout: 3000 },
      );
      await settled(panel);
      await DIALOG_SHEET.close();
      await frames();
      expect(document.activeElement).toBe(DIALOG_SHEET.trigger());
    });

    it("fades on the sheet's pace, and moves nothing but opacity", async () => {
      const set = renderSheet();
      const moved = watchTransitions();
      const runs = watchAnimations();
      const panel = await openSheet(set);
      const scrim = scrimOf(panel);
      set(false);
      await gone();
      moved.stop();
      runs.stop();
      const mine = moved.ran.filter((r) => r.target === panel || r.target === scrim);
      expect(mine.filter((r) => r.property !== "opacity").map((r) => r.property)).toEqual([]);
      const curve = rootEasing("--ui-ease-sheet");
      const sheetPace = [
        [rootMs("--ui-dur-slow"), curve],
        [rootMs("--ui-dur-base"), curve],
      ];
      const fade = (target: Element) =>
        mine.filter((r) => r.target === target).map((r) => [r.duration, r.easing]);
      expect(fade(panel)).toEqual(sheetPace);
      expect(fade(scrim)).toEqual(sheetPace);
      // Kobalte keeps the sheet mounted for these runs, which move nothing,
      // so it is still there while it fades out.
      expect(
        runs.started.filter((s) => s.target === panel).map((s) => [s.name, s.duration]),
      ).toEqual([
        ["ui-sheet-enter", rootMs("--ui-dur-slow")],
        ["ui-sheet-exit", rootMs("--ui-dur-base")],
      ]);
    });
  });
});
