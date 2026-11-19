/* Distortion Waves — Copyright (c) 2026 Jakub Antalik. MIT licence:
 * cire/waves/vendor/LICENSE, which ships in the bundle as
 * `DistortionWave.licence` (below). This file ports upstream's React wrapper,
 * packages/distortion-waves/src/DistortionWave.tsx, to Solid. */

/**
 * A wave that leaves a button, an edge or a point and crosses the element,
 * bending what is there and carrying one view into another. The engine is the
 * vendored `WaveController` (`../../vendor/controller.ts`), unedited; this is
 * the Solid wrapper round it, with upstream's defaults: the element is
 * pictured for the lens, the picture is taken at idle after mounting, and the
 * palette is the type's own.
 *
 * ```tsx
 * <DistortionWave revealed={sent()} revealedContent={<Receipt />}>
 *   <Review onSend={() => setSent(true)} />
 * </DistortionWave>
 * ```
 *
 * Three departures from upstream's wrapper. It has no `overlay` slot: nothing
 * here uses one, and it injected a `<style>` element. Its handle carries only
 * what a caller uses — `reset`, the element and the controller — not
 * upstream's `play`, `reverse` and `prepare`: `revealed` runs the wave both
 * ways, and the controller has all three for a caller that needs one. And a
 * controller call that throws (a shader the driver will not compile) does not
 * leave the view stuck: the wave becomes the controller's crossfade from then
 * on.
 */

import {
  children,
  createEffect,
  onCleanup,
  onMount,
  Show,
  splitProps,
  untrack,
  type JSX,
} from "solid-js";

import { WaveController, type WaveOptions } from "../../vendor/controller";
import LICENCE from "../../vendor/LICENSE?raw";
import { exposeHooks } from "../hooks";

export type {
  PaletteLike,
  PlayOptions,
  SourceLike,
  WaveOptions,
  WaveStyleInput,
} from "../../vendor/controller";
export { WaveController } from "../../vendor/controller";

export interface DistortionWaveProps
  extends
    WaveOptions,
    Omit<JSX.HTMLAttributes<HTMLDivElement>, keyof WaveOptions | "children" | "ref" | "style"> {
  /** What the wave passes over: the view that shows first. Give it an opaque
   *  background, or one behind the whole element. */
  children?: JSX.Element;
  /** The view the wave leaves behind it. Without one the wave passes over
   *  `children` and leaves them as they were. */
  revealedContent?: JSX.Element;
  /** Styles for the element, over its grid and isolation. */
  style?: JSX.CSSProperties;
  /** Receives the handle once the controller is made. */
  handle?: (handle: DistortionWaveHandle) => void;
}

export interface DistortionWaveHandle {
  /** Straight back to the first view, with no wave. */
  reset(): void;
  /** The wave's element. */
  readonly element: HTMLDivElement | null;
  /** The engine behind it, for benches; `null` once unmounted. */
  readonly controller: WaveController | null;
}

/* The two views share one grid cell. These objects never change, so Solid
   never writes over what the controller sets on the layers as it runs. */
const LAYER: JSX.CSSProperties = {
  "grid-area": "1 / 1",
  "min-width": "0",
  "min-height": "0",
  isolation: "isolate",
};
const LAYER_HIDDEN: JSX.CSSProperties = { ...LAYER, opacity: "0", "pointer-events": "none" };

const OPTION_KEYS = [
  "revealed",
  "type",
  "source",
  "focus",
  "waveStyle",
  "palette",
  "scale",
  "cornerRadius",
  "scrub",
  "capture",
  "live",
  "prewarm",
  "resolution",
  "reducedMotion",
  "onFinish",
] as const satisfies readonly (keyof WaveOptions)[];

/** The controller most recently mounted, for the development test hook. */
let latest: WaveController | null = null;
exposeHooks({ distortion: () => latest?.debug ?? null });

export function DistortionWave(props: DistortionWaveProps): JSX.Element {
  const [local, options, rest] = splitProps(
    props,
    ["children", "revealedContent", "style", "handle"],
    OPTION_KEYS,
  );

  let root!: HTMLDivElement;
  let first!: HTMLDivElement;
  let second: HTMLDivElement | undefined;
  let controller: WaveController | null = null;
  /** A controller call threw: every wave since is the crossfade. */
  let broken = false;

  // Which view the markup starts on. After that the controller decides.
  const startRevealed = untrack(() => !!options.revealed);
  // Resolved once: reading a JSX prop again would build its DOM again.
  const revealedView = children(() => local.revealedContent);
  const two = () =>
    revealedView.toArray().some((v) => v !== null && v !== undefined && v !== false);
  const keepSecond = (el: HTMLDivElement) => {
    second = el;
    onCleanup(() => {
      if (second === el) second = undefined;
    });
  };

  const current = (): WaveOptions => ({
    revealed: options.revealed,
    type: options.type,
    source: options.source,
    focus: options.focus,
    waveStyle: options.waveStyle,
    palette: options.palette,
    scale: options.scale,
    cornerRadius: options.cornerRadius,
    scrub: options.scrub,
    capture: options.capture,
    live: options.live,
    prewarm: options.prewarm,
    resolution: options.resolution,
    reducedMotion: broken ? "always" : options.reducedMotion,
    onFinish: options.onFinish,
  });

  /** Ends on the view `revealed` asks for, by the crossfade, after a throw. */
  function recover() {
    broken = true;
    const c = controller;
    if (!c) return;
    c.update(current());
    if (options.revealed === true) {
      c.play();
    } else if (options.revealed === false) {
      // oxlint-disable-next-line unicorn/no-array-reverse -- WaveController#reverse, not an array's
      c.reverse();
    }
  }

  onMount(() => {
    const made = new WaveController(root, first, second ?? null);
    controller = made;
    latest = made;
    onCleanup(() => {
      made.destroy();
      controller = null;
      if (latest === made) latest = null;
    });

    // Every option is read here, and whether there is a second view, so a
    // change to any of them reaches the controller. Created inside `onMount`,
    // so the refs are set before its first run.
    createEffect(() => {
      const next = current();
      two();
      made.setRevealedLayer(second ?? null);
      try {
        made.update(next);
      } catch {
        recover();
      }
    });

    local.handle?.({
      reset: () => controller?.reset(),
      get element() {
        return root ?? null;
      },
      get controller() {
        return controller;
      },
    });
  });

  return (
    <div
      ref={root}
      data-distortion-wave=""
      {...rest}
      style={{ display: "grid", isolation: "isolate", ...local.style }}
    >
      <div
        ref={first}
        data-dw-layer="content"
        style={two() && startRevealed ? LAYER_HIDDEN : LAYER}
      >
        {local.children}
      </div>
      <Show when={two()}>
        <div ref={keepSecond} data-dw-layer="revealed" style={startRevealed ? LAYER : LAYER_HIDDEN}>
          {revealedView()}
        </div>
      </Show>
    </div>
  );
}

/**
 * Upstream's copyright and MIT notice, word for word. The licence asks that it
 * travel with every copy of the vendored core, the built chunk included, and a
 * minified Vite 8 build keeps no comment, legal ones included. So the notice
 * is a string the component holds, which a bundle keeps for as long as it
 * keeps the component; `tests/hooks.test.ts` fails a production bundle
 * without it.
 */
DistortionWave.licence = LICENCE;
