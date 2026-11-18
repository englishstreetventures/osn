/**
 * The Gilded wave: a fixed frame handed over to or from the page by a wave of
 * the couple's gold that leaves the control pressed and crosses the screen.
 *
 * The hand-over is a same-document View Transition. The frame's picture is
 * held for the run and cut by a feathered circle on the wave's front
 * (`gilded.css`, `--cire-gilded-mask`), so the frame grows out of the source
 * over the live page, or the page grows back over it; a WebGL 2 canvas draws
 * the gold band, its crest, the colour left on the edges and the dust over the
 * transition (`overlay.ts`). The front, the mask and the gold come from one
 * function of progress (`wave.ts`), so they cannot drift apart. The page is
 * never pictured: what the mask reveals is the live DOM.
 *
 * The transition is the contract, the gold decoration: without WebGL 2, or
 * with a shader that will not build, the transition runs without the canvas.
 * Without View Transitions, and under reduced motion, the frame fades on the
 * panel-swap step (`--dur-slow`). Every path ends with the frame where
 * `revealed` asks, and calls `onHandover` and `onFinish` once.
 *
 * The frame is the caller's: any element, positioned by the caller. This owns
 * its `hidden` attribute, and between a wave's start and its hand-over its
 * `view-transition-name`.
 */

import "./gilded.css";
import { exposeHooks } from "../hooks";
import { readColours } from "./colours";
import { createOverlay, type Colours, type Overlay } from "./overlay";
import { handoverAt, maskAt, WAVE, waveAt, type Stage } from "./wave";

export type { Stage } from "./wave";

export interface GildedOptions {
  /** Whether the frame shows. Changing it runs the wave: out from the source
   *  to reveal the frame, and out from it again to give the page back. */
  revealed: boolean;
  /** The control the wave leaves from, read as a wave starts. A press on it
   *  leans the wave toward the side pressed; a key press goes straight. */
  source?: Element | null;
  /** "system" (default) follows the reader's reduced-motion setting and fades instead. */
  reducedMotion?: "system" | "always" | "never";
  /** Called when the new side has taken over and is live: the frame, or the
   *  page. The gold may still be fading on the edges. */
  onHandover?: (revealed: boolean) => void;
  /** Called when the wave, or the fade standing in for it, has ended. */
  onFinish?: (revealed: boolean) => void;
}

export interface GildedDebug {
  /** Progress of the wave running, 0–1. */
  readonly progress: number;
  /** What is running: the wave, the fade standing in for it, or nothing. */
  readonly mode: "wave" | "fade" | null;
  /** The wave running draws its gold. */
  readonly overlay: boolean;
  /** Where the wave running lies, in the overlay's device pixels. */
  readonly stage: Stage | null;
}

const ROOT_CLASS = "cire-gilded";
const FRAME_NAME = "cire-gilded-frame";
const FX_NAME = "cire-gilded-fx";
const MASK = "--cire-gilded-mask";
const DUR = "--cire-gilded-dur";
/** The frame's picture before the front reaches it: clear, or whole. */
const CLEAR = "linear-gradient(transparent, transparent)";
const WHOLE = "linear-gradient(#000, #000)";
/** A held wave's transition: long enough to screenshot at leisure. */
const HELD_FOR = "600s";
/** Past the run's end, a wave that has not ended is ended: never leave the
 *  organiser behind a frozen frame. */
const DEADLINE_SLACK_MS = 2500;
/** How recent a press on the source must be to lean the wave. */
const PRESS_WINDOW_MS = 2000;
/** The panel-swap step at a desk, for a page that does not define `--dur-slow`. */
const FADE_FALLBACK_MS = 200;
/** The top bar's height above the source the gold may reach into. */
const ABOVE_SOURCE_PX = 8;

interface Run {
  readonly to: boolean;
  readonly stage: Stage;
  readonly colours: Colours;
  readonly overlay: Overlay | null;
  /** The overlay canvas's corner less the frame's, in CSS pixels. */
  readonly offset: { readonly x: number; readonly y: number };
  vt: ViewTransition | null;
  /** Resolves true once the transition runs, false if it never does. */
  ready: Promise<boolean>;
  p: number;
  t0: number;
  raf: number;
  deadline: number;
  held: boolean;
  handed: boolean;
  ended: boolean;
}

interface Fade {
  readonly to: boolean;
  readonly animation: Animation | null;
  settled: boolean;
}

/** Where a held wave stands; `null` when none is held. */
let heldAt: number | null = null;
const live = new Set<GildedWave>();

/** Holds the Gilded wave, the one running or the next, at `p` (0–1) of its
 *  run; resolves once that frame is drawn. A development and test hook. */
export function holdGilded(p: number): Promise<void> {
  heldAt = Math.min(Math.max(p, 0), 1);
  const at = heldAt;
  return Promise.all([...live].map((wave) => wave.hold(at))).then(() => undefined);
}

/** Lets a held wave go: it ends where it was going, at once. */
export function releaseGilded(): void {
  heldAt = null;
  for (const wave of live) wave.release();
}

exposeHooks({ holdGilded, releaseGilded });

interface FadeTiming {
  readonly ms: number;
  readonly easing: string;
}

/** The panel-swap step and the arriving curve, from the page's own tokens. */
function fadeTiming(): FadeTiming {
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;transition-delay:var(--dur-slow);transition-timing-function:var(--ease-out)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const delay = style.transitionDelay;
  const easing = style.transitionTimingFunction;
  probe.remove();
  const n = Number.parseFloat(delay);
  const ms = delay.endsWith("ms") ? n : n * 1000;
  return { ms: ms > 0 ? ms : FADE_FALLBACK_MS, easing: easing || "ease-out" };
}

export class GildedWave {
  readonly frame: HTMLElement;
  private opts: GildedOptions = { revealed: false };
  private first = true;
  private destroyed = false;
  private run: Run | null = null;
  private fade: Fade | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private overlay: Overlay | null = null;
  /** WebGL 2 or the shaders failed here once: no overlay from now on. */
  private bare = false;
  private press: { x: number; t: number } | null = null;
  private abort = new AbortController();

  constructor(frame: HTMLElement) {
    this.frame = frame;
    live.add(this);
    document.addEventListener(
      "pointerdown",
      (e) => {
        const source = this.opts.source;
        if (source && e.target instanceof Node && source.contains(e.target)) {
          this.press = { x: e.clientX, t: performance.now() };
        }
      },
      { capture: true, passive: true, signal: this.abort.signal },
    );
  }

  /** The options as they now stand. The first call places the frame with no
   *  wave; a later one that changes `revealed` runs it. */
  update(next: GildedOptions): void {
    if (this.destroyed) return;
    const prev = this.opts;
    this.opts = next;
    if (this.first) {
      this.first = false;
      this.show(next.revealed);
      return;
    }
    if (next.revealed !== prev.revealed) this.go(next.revealed);
  }

  get debug(): GildedDebug {
    const run = this.run;
    return {
      progress: run?.p ?? 0,
      mode: run ? "wave" : this.fade && !this.fade.settled ? "fade" : null,
      overlay: !!run?.overlay,
      stage: run?.stage ?? null,
    };
  }

  /** Holds the wave running at `p`, or does nothing when none is; the next
   *  wave starts held at `heldAt` by itself. */
  async hold(p: number): Promise<void> {
    const run = this.run;
    if (!run || run.ended) return;
    if (!run.held) {
      run.held = true;
      cancelAnimationFrame(run.raf);
      clearTimeout(run.deadline);
      if (!run.handed) document.documentElement.style.setProperty(DUR, HELD_FOR);
    }
    if (await run.ready) this.frameAt(run, p);
  }

  /** Ends a held wave where it was going. */
  release(): void {
    if (this.run?.held) this.end(this.run);
  }

  /** Ends any wave at once, with no callback, and lets the canvas go. */
  destroy(): void {
    if (this.destroyed) return;
    if (this.run) this.end(this.run, false);
    if (this.fade) this.settle(this.fade, false);
    this.destroyed = true;
    live.delete(this);
    this.abort.abort();
    this.overlay?.dispose();
    this.overlay = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  private show(on: boolean) {
    this.frame.hidden = !on;
  }

  private motionless(): boolean {
    const r = this.opts.reducedMotion ?? "system";
    if (r !== "system") return r === "always";
    return (
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  private go(to: boolean) {
    // A turn mid-way ends the one running where it was going, then leaves.
    if (this.run) this.end(this.run);
    if (this.fade) this.settle(this.fade);
    if (this.frame.hidden !== to) return;
    if (this.motionless() || typeof document.startViewTransition !== "function") this.fadeTo(to);
    else this.wave(to);
  }

  // ─── The fade ───

  private fadeTo(to: boolean) {
    const { ms, easing } = fadeTiming();
    this.show(true);
    const animation =
      typeof this.frame.animate === "function"
        ? this.frame.animate([{ opacity: to ? 0 : 1 }, { opacity: to ? 1 : 0 }], {
            duration: ms,
            easing,
          })
        : null;
    const fade: Fade = { to, animation, settled: false };
    this.fade = fade;
    if (!animation) {
      this.settle(fade);
      return;
    }
    animation.addEventListener("finish", () => this.settle(fade), { once: true });
  }

  private settle(fade: Fade, notify = true) {
    if (fade.settled) return;
    fade.settled = true;
    fade.animation?.cancel();
    this.show(fade.to);
    if (this.fade === fade) this.fade = null;
    if (!notify) return;
    this.opts.onHandover?.(fade.to);
    this.opts.onFinish?.(fade.to);
  }

  // ─── The wave ───

  /** The frame's box, the overlay's, and the stage, with the frame shown
   *  for a moment if it is hidden. */
  private measure() {
    const frame = this.frame;
    const hidden = frame.hidden;
    if (hidden) {
      frame.style.visibility = "hidden";
      frame.hidden = false;
    }
    const box = frame.getBoundingClientRect();
    if (hidden) {
      frame.hidden = true;
      frame.style.visibility = "";
    }
    const source = this.opts.source;
    const from = source?.isConnected ? source.getBoundingClientRect() : null;
    const at =
      from && from.width > 0 && from.height > 0
        ? from
        : { left: box.left + box.width / 2, top: box.top, width: 0, height: 0 };
    const press =
      this.press && performance.now() - this.press.t < PRESS_WINDOW_MS ? this.press : null;
    this.press = null;
    const lean =
      press && at.width > 0
        ? Math.max(-1, Math.min(1, (press.x - (at.left + at.width / 2)) / (at.width / 2)))
        : 0;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const top = Math.max(0, Math.min(box.top, at.top - ABOVE_SOURCE_PX));
    const area = { left: box.left, top, width: box.width, height: Math.max(box.bottom - top, 1) };
    const stage: Stage = {
      W: Math.max(1, Math.round(area.width * dpr)),
      H: Math.max(1, Math.round(area.height * dpr)),
      vTop: (box.top - top) * dpr,
      dpr,
      src: [
        (at.left + at.width / 2 - area.left + lean * at.width * 0.3) * dpr,
        (at.top + at.height / 2 - top) * dpr,
      ],
      tilt: lean * 0.91 * 0.45,
    };
    return { area, stage, offset: { x: area.left - box.left, y: area.top - box.top } };
  }

  private ensureOverlay(): Overlay | null {
    if (this.overlay) return this.overlay;
    if (this.bare) return null;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-gilded-fx", "");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:fixed;pointer-events:none;display:none";
    const overlay = createOverlay(canvas);
    if (!overlay) {
      this.bare = true;
      return null;
    }
    canvas.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        if (this.canvas !== canvas) return;
        // Nothing to draw with now; the transition carries on without it.
        this.overlay = null;
        this.canvas = null;
        canvas.remove();
      },
      { signal: this.abort.signal },
    );
    document.body.append(canvas);
    this.canvas = canvas;
    this.overlay = overlay;
    return overlay;
  }

  private wave(to: boolean) {
    const { area, stage, offset } = this.measure();
    const overlay = this.ensureOverlay();
    const canvas = this.canvas;
    if (overlay && canvas) {
      const z = Number.parseInt(getComputedStyle(this.frame).zIndex, 10);
      Object.assign(canvas.style, {
        left: `${area.left}px`,
        top: `${area.top}px`,
        width: `${area.width}px`,
        height: `${area.height}px`,
        zIndex: String(Number.isFinite(z) ? z + 1 : 1),
        display: "block",
      });
      overlay.resize(stage);
      overlay.clear();
    }

    const root = document.documentElement;
    const held = heldAt;
    root.classList.add(ROOT_CLASS);
    root.style.setProperty(
      DUR,
      held !== null
        ? HELD_FOR
        : `${Math.max(150, Math.round(WAVE.duration * 1000 * handoverAt(stage)))}ms`,
    );
    root.style.setProperty(MASK, to ? CLEAR : WHOLE);
    this.frame.style.viewTransitionName = FRAME_NAME;
    if (overlay && canvas) canvas.style.viewTransitionName = FX_NAME;

    const run: Run = {
      to,
      stage,
      colours: readColours(this.frame, to),
      overlay,
      offset,
      vt: null,
      ready: Promise.resolve(false),
      p: 0,
      t0: -1,
      raf: 0,
      deadline: 0,
      held: held !== null,
      handed: false,
      ended: false,
    };
    this.run = run;
    const vt = document.startViewTransition(() => {
      if (!run.ended) this.show(to);
    });
    run.vt = vt;
    run.ready = vt.ready.then(
      () => !run.ended,
      () => false,
    );
    const handOver = () => this.handOver(run);
    vt.finished.then(handOver, handOver);
    void run.ready.then((running) => this.start(run, running));
  }

  /** The transition is up (or never came): hold, play, or end. */
  private start(run: Run, running: boolean) {
    if (!running) {
      this.end(run);
      return;
    }
    if (run.held) {
      this.frameAt(run, heldAt ?? 0);
      return;
    }
    run.deadline = window.setTimeout(() => this.end(run), WAVE.duration * 1000 + DEADLINE_SLACK_MS);
    run.raf = requestAnimationFrame((ts) => this.tick(run, ts));
  }

  private tick(run: Run, ts: number) {
    if (run.ended || run.held) return;
    if (run.t0 < 0) run.t0 = ts;
    const p = (ts - run.t0) / (WAVE.duration * 1000);
    if (p >= 1) {
      this.end(run);
      return;
    }
    this.frameAt(run, p);
    run.raf = requestAnimationFrame((next) => this.tick(run, next));
  }

  /** The mask and the gold at `p`. */
  private frameAt(run: Run, p: number) {
    if (run.ended) return;
    run.p = p;
    if (!run.handed) {
      const m = maskAt(run.stage, p);
      const k = 1 / run.stage.dpr;
      const x = (m.x * k + run.offset.x).toFixed(1);
      const y = (m.y * k + run.offset.y).toFixed(1);
      const a = Math.max(0, (m.r - m.inner) * k);
      const b = Math.max(a + 1, (m.r + m.outer) * k);
      const stops = run.to
        ? `#000 ${a.toFixed(1)}px, transparent ${b.toFixed(1)}px`
        : `transparent ${a.toFixed(1)}px, #000 ${b.toFixed(1)}px`;
      // On `<html>`, though every element under it then sees the change: the
      // transition's pseudo-elements inherit from the document element alone,
      // so a value on the frame or `<body>`, or one registered with
      // `inherits: false`, never reaches the picture it cuts.
      document.documentElement.style.setProperty(
        MASK,
        `radial-gradient(circle at ${x}px ${y}px, ${stops})`,
      );
    }
    run.overlay?.draw(run.stage, waveAt(run.stage, p), run.colours);
  }

  /** The new side is live: the transition's names and variables go. */
  private handOver(run: Run, notify = true) {
    if (run.handed) return;
    run.handed = true;
    if (this.run === run) {
      const root = document.documentElement;
      root.classList.remove(ROOT_CLASS);
      root.style.removeProperty(MASK);
      root.style.removeProperty(DUR);
      this.frame.style.viewTransitionName = "";
      if (this.canvas) this.canvas.style.viewTransitionName = "";
    }
    if (notify) this.opts.onHandover?.(run.to);
  }

  /** Ends `run` where it was going. */
  private end(run: Run, notify = true) {
    if (run.ended) return;
    run.ended = true;
    cancelAnimationFrame(run.raf);
    clearTimeout(run.deadline);
    this.show(run.to);
    if (!run.handed) {
      run.vt?.skipTransition();
      this.handOver(run, notify);
    }
    run.overlay?.clear();
    if (this.canvas) this.canvas.style.display = "none";
    if (this.run === run) this.run = null;
    if (notify) this.opts.onFinish?.(run.to);
  }
}
