// oxlint-disable vitest/expect-expect -- a picture tool, not a test: it asserts nothing, and runs only when asked.
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, describe, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../src/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/ui/dropdown-menu";
import { Modal } from "../src/ui/modal";
import { Popover, PopoverContent, PopoverTrigger } from "../src/ui/popover";
import { Tooltip } from "../src/ui/tooltip";

import "./test-support/tailwind.css";

/**
 * Pictures of each overlay opening and closing, for a person comparing motion
 * before and after a change: `Dialog` as a card and as a sheet (which slides
 * at 390px and is the card at 1440px), the card again with both scale tokens
 * at 1 (the fade with no scale an app opts into),
 * `DropdownMenu` in both looks, `Popover`, `Tooltip` and `Modal`, at 390 and
 * 1440px. Each run is held still through the
 * Web Animations API at 0, 25, 50, 75 and 100% of its longest animation and
 * drawn into `__screenshots__/` beside this file (gitignored), one PNG per
 * frame, named `<overlay>-<width>-<open|close>-<percent>.png`. A close with no
 * animation draws one frame, `-gone`. What must hold is asserted in
 * `overlay-motion.browser.test.tsx`, `tooltip-timing.browser.test.tsx` and
 * `modal.browser.test.tsx`; this file only draws, so it is no part of the
 * browser tier's run. It draws when asked:
 * `VITE_OVERLAY_MOTION_CAPTURE=1 bun run --cwd shared/ui test:browser
 * tests/overlay-motion.look.browser.test.tsx`.
 */

const DIR = "__screenshots__/overlay-motion.look.browser.test.tsx";
const WIDTHS = [390, 1440] as const;
const STOPS = [0, 25, 50, 75, 100] as const;

afterEach(() => {
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  for (const subject of SUBJECTS)
    for (const name of Object.keys(subject.tokens ?? {}))
      document.documentElement.style.removeProperty(name);
  cleanup();
});

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1)));
    step(n);
  });

/** The animations an overlay is running, the `::backdrop` included. */
function running(): Animation[] {
  return document
    .getAnimations()
    .filter(
      (a) => a.playState !== "finished" && a.effect?.getComputedTiming().endTime !== Infinity,
    );
}

/** Wait until something starts animating, and hold it at its first frame. */
async function catchRun(budgetMs: number): Promise<Animation[]> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    const now = running();
    if (now.length > 0) {
      for (const a of now) a.pause();
      return now;
    }
    if (performance.now() > deadline) return [];
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A picture of `rect` in the window, or of the whole window. */
async function shot(name: string, rect?: DOMRect) {
  const box = document.createElement("div");
  box.style.cssText = rect
    ? `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none`
    : "position:fixed;inset:0;pointer-events:none";
  document.body.append(box);
  await page.screenshot({ path: `${DIR}/${name}.png`, element: box });
  box.remove();
}

/** Step a held run through the stops, a picture at each, then let it finish. */
async function film(name: string, animations: Animation[], rect?: DOMRect) {
  if (animations.length === 0) {
    await frames();
    await shot(`${name}-gone`, rect);
    return;
  }
  const longest = Math.max(
    ...animations.map((a) => Number(a.effect?.getComputedTiming().endTime ?? 0)),
  );
  for (const stop of STOPS) {
    const at = (longest * stop) / 100;
    for (const a of animations) {
      const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
      a.currentTime = Math.min(at, end);
    }
    await frames();
    await shot(`${name}-${String(stop).padStart(3, "0")}`, rect);
  }
  for (const a of animations) a.finish();
}

interface Subject {
  name: string;
  view: () => JSX.Element;
  open: () => Promise<void>;
  close: () => Promise<void>;
  /** The part of the window to draw; the whole window when absent. */
  area?: () => DOMRect;
  /** How long a close may take to start: a tooltip waits out its close delay. */
  closeStarts?: number;
  /** How long an open may take to start: a tooltip waits out its open delay. */
  openStarts?: number;
  /** Contract tokens set on the root for this subject alone, as an app would map them. */
  tokens?: Record<string, string>;
}

const byName = (name: string) => () => screen.getByRole("button", { name });

/** Room around a trigger for a panel on either side of it. */
const around = (trigger: () => HTMLElement) => () => {
  const r = trigger().getBoundingClientRect();
  const left = Math.max(0, Math.min(r.left + r.width / 2 - 180, innerWidth - 360));
  return new DOMRect(left, r.top - 90, 360, 330);
};

const stage = (child: () => JSX.Element) => () => (
  <div style={{ display: "grid", "place-items": "center", height: "100vh" }}>
    <div style={{ display: "flex", "align-items": "center", gap: "48px" }}>
      {child()}
      <button type="button">Away</button>
    </div>
  </div>
);

function ModalStage() {
  const [open, setOpen] = createSignal(false);
  return (
    <div style={{ padding: "24px" }}>
      <p>Behind the modal: the page it opens over.</p>
      <button type="button" onClick={() => setOpen(true)}>
        Open modal
      </button>
      <Modal open={open()} onClose={() => setOpen(false)} label="A modal">
        <div style={{ padding: "24px" }}>
          <p>A modal's body.</p>
          <button type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </Modal>
    </div>
  );
}

/** `Dialog` as a bottom sheet below `md`, the shape most of musubi's dialogs and pulse's share dialog take. */
function SheetDialog() {
  return (
    <Dialog>
      <DialogTrigger>Open sheet</DialogTrigger>
      <DialogContent presentation="sheet">
        <div style={{ padding: "24px" }}>
          <DialogTitle>Share event</DialogTitle>
          <p>A link anyone can open.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const SUBJECTS: Subject[] = [
  {
    name: "dialog",
    view: stage(() => (
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <div style={{ padding: "24px" }}>
            <DialogTitle>A dialog</DialogTitle>
            <p>Its body.</p>
          </div>
        </DialogContent>
      </Dialog>
    )),
    open: () => userEvent.click(byName("Open dialog")()),
    close: () => userEvent.keyboard("{Escape}"),
  },
  {
    name: "dialog-sheet",
    view: stage(() => <SheetDialog />),
    open: () => userEvent.click(byName("Open sheet")()),
    close: () => userEvent.keyboard("{Escape}"),
  },
  {
    // The opt-in fade with no scale: both scale tokens at 1. On the card, since
    // a sheet below `md` slides whatever the scale tokens hold.
    name: "dialog-fade",
    view: stage(() => (
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <div style={{ padding: "24px" }}>
            <DialogTitle>A dialog</DialogTitle>
            <p>Its body.</p>
          </div>
        </DialogContent>
      </Dialog>
    )),
    open: () => userEvent.click(byName("Open dialog")()),
    close: () => userEvent.keyboard("{Escape}"),
    tokens: { "--ui-scale-enter": "1", "--ui-scale-exit": "1" },
  },
  {
    name: "menu-default",
    view: stage(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent class="w-52">
          <DropdownMenuItem>Switch profile</DropdownMenuItem>
          <DropdownMenuItem>Settings</DropdownMenuItem>
          <DropdownMenuItem>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )),
    open: () => userEvent.click(byName("Open menu")()),
    close: () => userEvent.keyboard("{Escape}"),
    area: around(byName("Open menu")),
  },
  {
    name: "menu-accent",
    view: stage(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent" class="w-52">
          <DropdownMenuItem>Switch profile</DropdownMenuItem>
          <DropdownMenuItem>Settings</DropdownMenuItem>
          <DropdownMenuItem>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )),
    open: () => userEvent.click(byName("Open menu")()),
    close: () => userEvent.keyboard("{Escape}"),
    area: around(byName("Open menu")),
  },
  {
    name: "popover",
    view: stage(() => (
      <Popover>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent>A popover's body, a line or two of explanation.</PopoverContent>
      </Popover>
    )),
    open: () => userEvent.click(byName("Open popover")()),
    close: () => userEvent.keyboard("{Escape}"),
    area: around(byName("Open popover")),
  },
  {
    name: "tooltip",
    view: stage(() => (
      <Tooltip text="Recorded by a host from a phone call">
        <span>Host-entered</span>
      </Tooltip>
    )),
    open: () => userEvent.hover(screen.getByText("Host-entered")),
    close: () => userEvent.hover(byName("Away")()),
    area: around(() => screen.getByText("Host-entered")),
    openStarts: 1500,
    closeStarts: 600,
  },
  {
    name: "modal",
    view: () => <ModalStage />,
    open: () => userEvent.click(byName("Open modal")()),
    close: () => userEvent.click(byName("Done")()),
  },
];

describe.runIf(import.meta.env.VITE_OVERLAY_MOTION_CAPTURE === "1")("overlay motion, drawn", () => {
  for (const width of WIDTHS) {
    for (const subject of SUBJECTS) {
      it(`${subject.name} at ${width}`, async () => {
        await page.viewport(width, 800);
        for (const [name, value] of Object.entries(subject.tokens ?? {}))
          document.documentElement.style.setProperty(name, value);
        render(subject.view);
        await document.fonts.ready;
        await vi.waitFor(() => {
          if (innerWidth !== width) throw new Error("viewport not resized yet");
        });
        await frames();
        const area = subject.area?.();

        await subject.open();
        await film(
          `${subject.name}-${width}-open`,
          await catchRun(subject.openStarts ?? 500),
          area,
        );
        await vi.waitFor(() => {
          if (running().length > 0) throw new Error("still opening");
        });
        await frames();

        await subject.close();
        await film(
          `${subject.name}-${width}-close`,
          await catchRun(subject.closeStarts ?? 300),
          area,
        );
        await new Promise((r) => setTimeout(r, 500));
      });
    }
  }
});
