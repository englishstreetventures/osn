/**
 * The Solid wrapper round the vendored controller, in Chromium: one test per
 * way it can fail (NEW-FEAT.md, isolated tests 1–5 and 5b).
 *
 * The wave's own frames are the controller's, which upstream tests; these
 * check what the wrapper owns: that it makes and destroys one controller, that
 * the markup starts on the right view, that `revealed` reaches the controller
 * and `onFinish` comes back, that reduced motion is a crossfade, and that a
 * renderer that throws, on the way out or on the way back, leaves a crossfade
 * rather than a stuck view.
 *
 * The wave runs on a short `waveStyle`, so a test waits a fraction of a second
 * rather than upstream's four.
 */

import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";

import {
  DistortionWave,
  type DistortionWaveHandle,
  type DistortionWaveProps,
} from "../src/distortion/DistortionWave";

type MediaPreference = { reducedMotion?: "reduce" | "no-preference" };
const emulateMedia = (options: MediaPreference) =>
  (commands as unknown as { emulateMedia: (o: MediaPreference) => Promise<void> }).emulateMedia(
    options,
  );

/** A quick wave: every phase a fraction of upstream's. */
const QUICK = {
  anticipation: 0.05,
  travel: 0.35,
  linger: 0,
  rimFade: 0.25,
  hairlineLinger: 0,
  hairlineFade: 0.25,
  particleLife: 0.25,
};

const view = (label: string, colour: string): JSX.Element => (
  <div data-view={label} style={{ height: "240px", background: colour }}>
    {label}
  </div>
);

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

function mount(props: () => Partial<DistortionWaveProps>) {
  host = document.createElement("div");
  host.style.width = "360px";
  document.body.append(host);
  let handle: DistortionWaveHandle | undefined;
  dispose = render(
    () => (
      <DistortionWave
        type="center"
        waveStyle={QUICK}
        revealedContent={view("second", "#f3ecdf")}
        handle={(h) => (handle = h)}
        {...props()}
      >
        {view("first", "#233128")}
      </DistortionWave>
    ),
    host,
  );
  return {
    get handle() {
      return handle!;
    },
    root: () => host!.querySelector<HTMLElement>("[data-distortion-wave]")!,
    layer: (which: "content" | "revealed") =>
      host!.querySelector<HTMLElement>(`[data-dw-layer="${which}"]`)!,
  };
}

/** Resolves once `onFinish` has been called `count` times. */
function finishes() {
  const calls: boolean[] = [];
  const onFinish = vi.fn((revealed: boolean) => calls.push(revealed));
  return { onFinish, calls };
}

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  host?.remove();
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await emulateMedia({ reducedMotion: "no-preference" });
});

describe("DistortionWave", () => {
  it("makes one controller canvas once the browser is idle, and takes it away on unmount", async () => {
    const wave = mount(() => ({}));
    // The precondition the rest stands on: this Chromium gives a WebGL 2
    // context, so prewarm makes the renderer.
    await vi.waitFor(() => expect(wave.handle.controller?.debug.webgl).toBe(true), {
      timeout: 5000,
    });
    const canvases = wave.root().querySelectorAll(":scope > canvas");
    expect(canvases).toHaveLength(1);
    const canvas = canvases[0] as HTMLCanvasElement;

    dispose!();
    dispose = undefined;
    expect(canvas.isConnected).toBe(false);
    // Destroyed, not merely detached: the controller gave its context back
    // (browsers allow only so many), and the handle answers no more.
    expect(canvas.getContext("webgl2")?.isContextLost()).toBe(true);
    expect(wave.handle.controller).toBeNull();
  });

  it("starts on the second view when revealed at mount, the first inert and hidden", () => {
    const wave = mount(() => ({ revealed: true }));
    const first = wave.layer("content");
    const second = wave.layer("revealed");
    expect(first.inert).toBe(true);
    expect(first.getAttribute("aria-hidden")).toBe("true");
    expect(second.inert).toBe(false);
    expect(second.hasAttribute("aria-hidden")).toBe(false);
    expect(getComputedStyle(second).opacity).toBe("1");
  });

  it("runs to the second view on a flip and back on the next, calling onFinish once each way", async () => {
    const [revealed, setRevealed] = createSignal(false);
    const { onFinish, calls } = finishes();
    const wave = mount(() => ({ revealed: revealed(), onFinish }));
    await vi.waitFor(() => expect(wave.handle.controller?.debug.webgl).toBe(true), {
      timeout: 5000,
    });

    setRevealed(true);
    await vi.waitFor(() => expect(calls).toEqual([true]), { timeout: 5000 });
    expect(wave.layer("content").inert).toBe(true);
    expect(wave.layer("revealed").inert).toBe(false);

    setRevealed(false);
    await vi.waitFor(() => expect(calls).toEqual([true, false]), { timeout: 5000 });
    expect(wave.layer("content").inert).toBe(false);
    expect(wave.layer("revealed").inert).toBe(true);
    expect(onFinish).toHaveBeenCalledTimes(2);
  });

  it("crossfades under reduced motion and still calls onFinish", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    const [revealed, setRevealed] = createSignal(false);
    const { calls } = finishes();
    const modes: unknown[] = [];
    const wave = mount(() => ({
      revealed: revealed(),
      onFinish: (r: boolean) => calls.push(r),
    }));

    setRevealed(true);
    modes.push(wave.handle.controller?.debug.mode);
    await vi.waitFor(() => expect(calls).toEqual([true]), { timeout: 3000 });
    expect(modes).toEqual(["fade"]);
    // No wave was drawn: the canvas, if prewarm made one, never showed.
    const canvas = wave.root().querySelector<HTMLCanvasElement>(":scope > canvas");
    expect(canvas === null || canvas.style.display === "none").toBe(true);
    expect(wave.layer("revealed").inert).toBe(false);
  });

  it("falls back to the crossfade when the renderer throws", async () => {
    // Every shader fails to compile, so `new WaveRenderer` throws. Prewarm
    // would meet that first, at idle, outside the wrapper; hold the idle
    // callbacks so the press is where it meets it, as a page does whose
    // prewarm already failed.
    vi.stubGlobal("requestIdleCallback", () => 0);
    vi.spyOn(WebGL2RenderingContext.prototype, "getShaderParameter").mockReturnValue(false);
    const [revealed, setRevealed] = createSignal(false);
    const { calls } = finishes();
    const wave = mount(() => ({
      revealed: revealed(),
      onFinish: (r: boolean) => calls.push(r),
    }));

    expect(() => setRevealed(true)).not.toThrow();
    expect(wave.handle.controller?.debug.mode).toBe("fade");
    await vi.waitFor(() => expect(calls).toEqual([true]), { timeout: 3000 });
    expect(wave.layer("revealed").inert).toBe(false);
    expect(wave.layer("content").inert).toBe(true);

    // And it stays a crossfade: the next flip does not try the renderer again.
    setRevealed(false);
    await vi.waitFor(() => expect(calls).toEqual([true, false]), { timeout: 3000 });
    expect(wave.root().querySelector(":scope > canvas")).toBeNull();
  });

  it("falls back to the crossfade on the way back when the renderer first throws there", async () => {
    // Opened at mount, so the first wave the renderer is asked for runs back.
    vi.stubGlobal("requestIdleCallback", () => 0);
    vi.spyOn(WebGL2RenderingContext.prototype, "getShaderParameter").mockReturnValue(false);
    const [revealed, setRevealed] = createSignal(true);
    const { calls } = finishes();
    const wave = mount(() => ({
      revealed: revealed(),
      onFinish: (r: boolean) => calls.push(r),
    }));
    expect(wave.layer("content").inert).toBe(true);

    expect(() => setRevealed(false)).not.toThrow();
    expect(wave.handle.controller?.debug.mode).toBe("fade");
    await vi.waitFor(() => expect(calls).toEqual([false]), { timeout: 3000 });
    expect(wave.layer("content").inert).toBe(false);
    expect(wave.layer("revealed").inert).toBe(true);
  });
});
