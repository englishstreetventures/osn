import { clsx } from "clsx";
import { createEffect, onCleanup, onMount, untrack } from "solid-js";

// `import type`, never a value import: `orb-api.ts` declares `Orb` with
// `declare const`, which emits nothing, so a value import would bind to
// nothing at runtime.
import type * as Api from "./orb-api";
import type { OrbProps, OrbState } from "./orb-api";

export type { OrbProps, OrbState } from "./orb-api";
import { type OrbFrame, type OrbTint, paintFrame } from "../../vendor/thinking-orbs/engine/core";
import { MODE_FRAMES } from "../../vendor/thinking-orbs/engine/registry";
import { type Resolved, resolvePreset } from "../../vendor/thinking-orbs/presets";

// The Solid half of the orb. The vendored engine (`shared/ui/vendor/
// thinking-orbs`) turns a state, a size and a time into a list of dots and
// paints them into a 2D context; everything about when to paint, and in what
// colour, lives here.
//
// One loop for every orb. Module scope holds the mounted orbs and, while at
// least one is mounted, one `requestAnimationFrame` callback, one
// `IntersectionObserver`, one `ResizeObserver`, one `MutationObserver` on the
// root element, one `visibilitychange` listener and the media queries below.
// Each frame paints every moving orb from the frame's own timestamp, so two
// orbs of one state and size are always in the same phase, and builds each
// state-and-size frame once however many orbs draw it. No frame is requested
// while no orb is moving on screen, the tab is hidden or motion is reduced.
// Nothing here touches a browser global until the first orb mounts, so
// importing the module on a server is safe.
//
// An orb holds one still frame, at the time upstream's own component uses
// (`t = 0.6`), under reduced motion and once it has moved for five seconds.
// It follows a live change of the motion preference both ways.
//
// The ink is the colour the canvas inherits (`currentColor`), read from its
// computed style: the engine draws the near dots in it and fades the far ones
// toward white, or toward black when the colour is light enough to sit on a
// dark ground. A moving orb re-reads it every frame; a still one when its
// props change, the root element's class, style or `data-theme` changes, or
// the colour-scheme or forced-colours preference changes.

const STILL_TIME = 0.6;
const MAX_PIXEL_RATIO = 2;
/**
 * How long an orb moves before it holds its still frame. Moving content that
 * starts by itself and runs longer than five seconds beside other content
 * needs a way to stop it (WCAG 2.2.2); stopping at five needs none.
 */
const MOTION_LIMIT_MS = 5000;
/**
 * The relative luminance at which a colour has the same contrast with black
 * as with white. An ink lighter than this reads better on black, so the
 * ground behind it is taken to be dark.
 */
const EVEN_CONTRAST_LUMINANCE = 0.179;

const BOX = {
  20: "base:size-5",
  64: "base:size-16",
} satisfies Readonly<Record<OrbProps["size"], string>>;

interface Mounted {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
  /** The canvas's computed style, which the browser keeps current. */
  style: CSSStyleDeclaration | undefined;
  state: OrbState;
  size: OrbProps["size"];
  preset: Resolved;
  /** The computed `color` the ink was last taken from. */
  color: string | undefined;
  tint: OrbTint | undefined;
  /** The ink is light, so the engine fades far dots toward black. */
  dark: boolean;
  /** The CSS width the canvas last measured; 0 until it has, and after a size change. */
  box: number;
  /** Canvas pixels per unit of the engine's drawing space (`size` units across). */
  scale: number;
  onScreen: boolean;
  /** The frame time of the orb's first moving paint on screen. */
  movingSince: number | undefined;
  /** It has moved for `MOTION_LIMIT_MS` and holds its still frame from now on. */
  settled: boolean;
}

const mounted = new Map<Element, Mounted>();
let pending = 0;
let onScreenObserver: IntersectionObserver | undefined;
let boxObserver: ResizeObserver | undefined;
let rootObserver: MutationObserver | undefined;
let motion: MediaQueryList | undefined;
let resolution: MediaQueryList | undefined;
let colourQueries: MediaQueryList[] = [];
/** The motion preference as the orbs last painted for it. */
let held = false;
/** Frames built during the current tick, by state and size. */
const built = new Map<string, OrbFrame>();
/** Computed colours already resolved to sRGB. */
const tints = new Map<string, OrbTint | undefined>();
let probe: CanvasRenderingContext2D | null | undefined;

function reduced(): boolean {
  return motion?.matches ?? false;
}

/** Whether the orb would be drawing moving frames, were motion allowed and the tab shown. */
function canMove(orb: Mounted): boolean {
  return orb.context !== null && orb.onScreen && !orb.settled;
}

function draw(orb: Mounted, frame: OrbFrame) {
  const context = orb.context;
  if (!context) return;
  context.setTransform(orb.scale, 0, 0, orb.scale, 0, 0);
  context.clearRect(0, 0, orb.size, orb.size);
  paintFrame(context, frame, orb.dark, orb.tint);
}

function frameAt(orb: Mounted, seconds: number): OrbFrame {
  const { mode, speed, opts } = orb.preset;
  return MODE_FRAMES[mode](orb.size, seconds * speed, opts);
}

/** Paints one orb now: the still frame, or the moving frame for this instant. */
function paintNow(orb: Mounted) {
  if (!orb.context) return;
  if (orb.settled || reduced()) {
    const { mode, opts } = orb.preset;
    draw(orb, MODE_FRAMES[mode](orb.size, STILL_TIME, opts));
  } else {
    draw(orb, frameAt(orb, performance.now() / 1000));
  }
}

/**
 * The sRGB value the browser gives a CSS colour, whatever syntax or colour
 * space it was written in (`oklch()`, a system colour under forced colours),
 * read back from one pixel. `undefined` where it cannot be read, or the colour
 * is fully transparent.
 */
function resolveColor(color: string): OrbTint | undefined {
  if (tints.has(color)) return tints.get(color);
  if (probe === undefined) {
    const scratch = document.createElement("canvas");
    scratch.width = 1;
    scratch.height = 1;
    probe = scratch.getContext("2d", { willReadFrequently: true });
  }
  let tint: OrbTint | undefined;
  if (probe && color) {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "transparent";
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
    if (a > 0) tint = { r, g, b };
  }
  tints.set(color, tint);
  return tint;
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance above the even-contrast point: a light ink. */
function isLight({ r, g, b }: OrbTint): boolean {
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > EVEN_CONTRAST_LUMINANCE;
}

/** Re-reads the colour the canvas inherits. Returns whether the ink changed. */
function readInk(orb: Mounted): boolean {
  const color = orb.style?.color ?? "";
  if (color === orb.color) return false;
  orb.color = color;
  orb.tint = resolveColor(color);
  orb.dark = orb.tint !== undefined && isLight(orb.tint);
  return true;
}

/** Repaints every orb whose inherited colour has changed. */
function recolour() {
  for (const orb of mounted.values()) if (readInk(orb)) paintNow(orb);
}

/**
 * Sizes the backing store from the box the canvas takes, at up to two device
 * pixels per CSS pixel. The box is `rem`-based, so it grows with the root font
 * size; until the canvas has measured it, the nominal size stands in. Returns
 * whether the bitmap was resized, which clears it.
 */
function fit(orb: Mounted): boolean {
  const ratio = Math.min(MAX_PIXEL_RATIO, devicePixelRatio || 1);
  const backing = Math.round((orb.box || orb.size) * ratio);
  orb.scale = backing / orb.size;
  if (orb.canvas.width === backing && orb.canvas.height === backing) return false;
  orb.canvas.width = backing;
  orb.canvas.height = backing;
  return true;
}

/**
 * Paints every orb whose moving frame is due. Orbs of one state and size share
 * the frame's geometry; each paints it in its own ink and at its own scale.
 */
function tick(time: number) {
  pending = 0;
  followMotion();
  if (!held) {
    for (const orb of mounted.values()) {
      if (!canMove(orb)) continue;
      orb.movingSince ??= time;
      if (time - orb.movingSince >= MOTION_LIMIT_MS) {
        orb.settled = true;
        paintNow(orb);
        continue;
      }
      readInk(orb);
      const key = `${orb.state}-${orb.size}`;
      let frame = built.get(key);
      if (!frame) {
        frame = frameAt(orb, time / 1000);
        built.set(key, frame);
      }
      draw(orb, frame);
    }
    built.clear();
  }
  schedule();
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

function shouldRun(): boolean {
  if (reduced() || document.visibilityState === "hidden") return false;
  for (const orb of mounted.values()) if (canMove(orb)) return true;
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

/**
 * Takes each canvas's measured box. The browser delivers these after layout
 * and before paint, so no read here forces a layout, and a resized bitmap is
 * redrawn before it is seen.
 */
function onResize(entries: ResizeObserverEntry[]) {
  for (const entry of entries) {
    const orb = mounted.get(entry.target);
    if (!orb) continue;
    orb.box = entry.contentRect.width;
    if (fit(orb)) paintNow(orb);
  }
}

function onMotionChange() {
  followMotion();
  schedule();
}

/**
 * Follows the device pixel ratio, which a zoom or a move to another screen
 * changes. The query matches only the ratio it was made for, so it fires once
 * and is made again for the new one.
 */
function watchResolution() {
  resolution?.removeEventListener("change", onResolution);
  resolution = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
  resolution.addEventListener("change", onResolution);
}

function onResolution() {
  watchResolution();
  for (const orb of mounted.values()) if (fit(orb)) paintNow(orb);
}

function start() {
  if (typeof IntersectionObserver !== "undefined") {
    onScreenObserver = new IntersectionObserver(onIntersect);
  }
  if (typeof ResizeObserver !== "undefined") boxObserver = new ResizeObserver(onResize);
  if (typeof MutationObserver !== "undefined") {
    rootObserver = new MutationObserver(recolour);
    rootObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
  }
  if (typeof matchMedia === "function") {
    motion = matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", onMotionChange);
    colourQueries = ["(prefers-color-scheme: dark)", "(forced-colors: active)"].map((query) => {
      const list = matchMedia(query);
      list.addEventListener("change", recolour);
      return list;
    });
    watchResolution();
  }
  held = reduced();
  document.addEventListener("visibilitychange", schedule);
}

function stop() {
  onScreenObserver?.disconnect();
  onScreenObserver = undefined;
  boxObserver?.disconnect();
  boxObserver = undefined;
  rootObserver?.disconnect();
  rootObserver = undefined;
  motion?.removeEventListener("change", onMotionChange);
  motion = undefined;
  for (const list of colourQueries) list.removeEventListener("change", recolour);
  colourQueries = [];
  resolution?.removeEventListener("change", onResolution);
  resolution = undefined;
  tints.clear();
  document.removeEventListener("visibilitychange", schedule);
}

function attach(orb: Mounted) {
  if (mounted.size === 0) start();
  mounted.set(orb.canvas, orb);
  // With an observer, an orb counts as on screen once its first entry says
  // so; without one, it always does.
  orb.onScreen = onScreenObserver === undefined;
  onScreenObserver?.observe(orb.canvas);
  boxObserver?.observe(orb.canvas);
}

function detach(orb: Mounted) {
  onScreenObserver?.unobserve(orb.canvas);
  boxObserver?.unobserve(orb.canvas);
  mounted.delete(orb.canvas);
  if (mounted.size === 0) stop();
  schedule();
}

export const Orb: typeof Api.Orb = (props) => {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const orb: Mounted = {
      canvas,
      context: canvas.getContext("2d"),
      style: typeof getComputedStyle === "function" ? getComputedStyle(canvas) : undefined,
      state: "working",
      size: props.size,
      preset: resolvePreset("working", props.size),
      color: undefined,
      tint: undefined,
      dark: false,
      box: 0,
      scale: 1,
      onScreen: false,
      movingSince: undefined,
      settled: false,
    };
    attach(orb);
    onCleanup(() => detach(orb));

    createEffect(() => {
      const state = props.state ?? "working";
      const size = props.size;
      untrack(() => {
        // A new size is a new box, which the observer measures after layout.
        if (size !== orb.size) orb.box = 0;
        orb.state = state;
        orb.size = size;
        orb.preset = resolvePreset(state, size);
        fit(orb);
        readInk(orb);
        paintNow(orb);
        schedule();
      });
    });
  });

  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      class={clsx(
        "base:inline-block base:shrink-0 base:align-middle",
        BOX[props.size],
        props.class,
      )}
    />
  );
};
