import { clsx } from "clsx";
import { createEffect, onCleanup, onMount, untrack } from "solid-js";

// `import type`, never a value import: `orb-api.ts` declares `Orb` with
// `declare const`, which emits nothing, so a value import would bind to
// nothing at runtime.
import type * as Api from "./orb-api";
import type { OrbProps, OrbState } from "./orb-api";

export type { OrbProps, OrbState } from "./orb-api";
import { paintFrame } from "../../vendor/thinking-orbs/engine/core";
import { MODE_FRAMES } from "../../vendor/thinking-orbs/engine/registry";
import { resolvePreset } from "../../vendor/thinking-orbs/presets";

// The Solid half of the orb. The vendored engine (`shared/ui/vendor/
// thinking-orbs`) turns a state, a size and a time into a list of dots and
// paints them into a 2D context; everything about when to paint lives here.
//
// One loop for every orb. Module scope holds the mounted orbs and, while at
// least one is mounted, one `requestAnimationFrame` callback, one
// `IntersectionObserver`, one `visibilitychange` listener and one
// reduced-motion query. Each frame paints every orb that is on screen from the
// frame's own timestamp, so two orbs of one state and size are always in the
// same phase. No frame is requested while no orb is on screen, the tab is
// hidden or motion is reduced. Nothing here touches a browser global until the
// first orb mounts, so importing the module on a server is safe.
//
// Reduced motion draws one still frame, at the time upstream's own component
// uses (`t = 0.6`), and follows a live change of the preference both ways.

const STILL_TIME = 0.6;
const MAX_PIXEL_RATIO = 2;

const BOX = {
  20: "base:size-5",
  64: "base:size-16",
} satisfies Readonly<Record<OrbProps["size"], string>>;

interface Mounted {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
  state: OrbState;
  size: OrbProps["size"];
  dark: boolean;
  /** Canvas pixels per unit of the engine's drawing space (`size` units across). */
  scale: number;
  onScreen: boolean;
}

const mounted = new Map<Element, Mounted>();
let pending = 0;
let observer: IntersectionObserver | undefined;
let motion: MediaQueryList | undefined;
/** The motion preference as the orbs last painted for it. */
let held = false;

function reduced(): boolean {
  return motion?.matches ?? false;
}

function paint(orb: Mounted, seconds: number | null) {
  const context = orb.context;
  if (!context) return;
  const preset = resolvePreset(orb.state, orb.size);
  const t = seconds === null ? STILL_TIME : seconds * preset.speed;
  context.setTransform(orb.scale, 0, 0, orb.scale, 0, 0);
  context.clearRect(0, 0, orb.size, orb.size);
  paintFrame(context, MODE_FRAMES[preset.mode](orb.size, t, preset.opts), orb.dark);
}

/** Paints one orb now: the still frame, or the moving frame for this instant. */
function paintNow(orb: Mounted) {
  paint(orb, reduced() ? null : performance.now() / 1000);
}

/**
 * Repaints every orb when the motion preference differs from the one they were
 * last painted for. Chromium fires no `change` event when `matches` is read
 * between the preference changing and the event's dispatch, and the loop reads
 * it every frame, so the loop checks for itself as well as listening.
 */
function followMotion() {
  const now = reduced();
  if (now === held) return;
  held = now;
  for (const orb of mounted.values()) paintNow(orb);
}

function tick(time: number) {
  pending = 0;
  followMotion();
  if (!held) {
    for (const orb of mounted.values()) {
      if (orb.onScreen) paint(orb, time / 1000);
    }
  }
  schedule();
}

function shouldRun(): boolean {
  if (reduced() || document.visibilityState === "hidden") return false;
  for (const orb of mounted.values()) if (orb.onScreen) return true;
  return false;
}

/** Requests the next frame when one is wanted, and cancels it when not. */
function schedule() {
  if (shouldRun()) {
    if (pending === 0) pending = requestAnimationFrame(tick);
  } else if (pending !== 0) {
    cancelAnimationFrame(pending);
    pending = 0;
  }
}

function onIntersect(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    const orb = mounted.get(entry.target);
    if (orb) orb.onScreen = entry.isIntersecting;
  }
  schedule();
}

function onMotionChange() {
  followMotion();
  schedule();
}

function attach(orb: Mounted) {
  if (mounted.size === 0) {
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(onIntersect);
    }
    if (typeof matchMedia === "function") {
      motion = matchMedia("(prefers-reduced-motion: reduce)");
      motion.addEventListener("change", onMotionChange);
    }
    held = reduced();
    document.addEventListener("visibilitychange", schedule);
  }
  mounted.set(orb.canvas, orb);
  // With an observer, an orb counts as on screen once its first entry says
  // so; without one, it always does.
  orb.onScreen = observer === undefined;
  observer?.observe(orb.canvas);
}

function detach(orb: Mounted) {
  observer?.unobserve(orb.canvas);
  mounted.delete(orb.canvas);
  if (mounted.size === 0) {
    observer?.disconnect();
    observer = undefined;
    motion?.removeEventListener("change", onMotionChange);
    motion = undefined;
    document.removeEventListener("visibilitychange", schedule);
  }
  schedule();
}

/**
 * Sizes the backing store from the box the canvas actually takes, at up to two
 * device pixels per CSS pixel. The box is `rem`-based, so it grows with the
 * root font size; measuring it keeps the bitmap sharp there. A box that
 * measures nothing (a hidden parent) falls back to the nominal size. A later
 * change of zoom or screen is not followed.
 */
function fitBacking(orb: Mounted) {
  const box = orb.canvas.getBoundingClientRect().width || orb.size;
  const ratio = Math.min(MAX_PIXEL_RATIO, devicePixelRatio || 1);
  const backing = Math.round(box * ratio);
  orb.canvas.width = backing;
  orb.canvas.height = backing;
  orb.scale = backing / orb.size;
}

export const Orb: typeof Api.Orb = (props) => {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const orb: Mounted = {
      canvas,
      context: canvas.getContext("2d"),
      state: "working",
      size: props.size,
      dark: false,
      scale: 1,
      onScreen: false,
    };
    attach(orb);
    onCleanup(() => detach(orb));

    let sized: OrbProps["size"] | undefined;
    createEffect(() => {
      const state = props.state ?? "working";
      const size = props.size;
      const dark = props.dark ?? false;
      untrack(() => {
        orb.state = state;
        orb.size = size;
        orb.dark = dark;
        if (size !== sized) {
          sized = size;
          fitBacking(orb);
        }
        paintNow(orb);
        schedule();
      });
    });
  });

  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      class={clsx("base:block base:shrink-0", BOX[props.size], props.class)}
    />
  );
};
