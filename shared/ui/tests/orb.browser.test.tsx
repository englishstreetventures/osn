/**
 * The orb, read back from the pixels it painted.
 *
 * Everything the wrapper promises is about when it paints and what: holding
 * still for reduced motion and after five seconds, stopping off screen and in
 * a hidden tab, one loop for every orb, a sharp bitmap, ink in the colour the
 * canvas inherits. None of that is
 * visible to a DOM shim, where `getContext` returns null, so every claim here
 * is made in real Chromium against `getImageData`.
 *
 * A frame is "blank" when no pixel has any alpha. Frames are waited for with
 * the browser's own `requestAnimationFrame`, captured before any test can
 * replace it, so a test that counts the orb's calls never counts its own.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, For, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import { Orb } from "../src/ui/orb";
import type { OrbState } from "../src/ui/orb-api";

import "./test-support/tailwind.css";

type MediaOptions = { reducedMotion: "reduce" | "no-preference" };
const emulateMedia = (options: MediaOptions) =>
  (commands as unknown as { emulateMedia: (o: MediaOptions) => Promise<void> }).emulateMedia(
    options,
  );

const nativeRaf = window.requestAnimationFrame.bind(window);
const rafDescriptor = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
const dprDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");

const STATES = [
  "working",
  "searching",
  "solving",
  "listening",
  "connecting",
  "weaving",
  "composing",
  "breathing",
  "shaping",
] as const satisfies readonly OrbState[];

const SHOTS = "../../../e2e-artifacts/shared-ui-orb";

afterEach(async () => {
  cleanup();
  if (rafDescriptor) Object.defineProperty(window, "requestAnimationFrame", rafDescriptor);
  if (dprDescriptor) Object.defineProperty(window, "devicePixelRatio", dprDescriptor);
  Reflect.deleteProperty(document, "visibilityState");
  document.documentElement.style.fontSize = "";
  document.documentElement.style.color = "";
  await emulateMedia({ reducedMotion: "no-preference" });
});

/** Resolves after `n` of the browser's frames. */
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<number>((resolve) => nativeRaf(resolve));
  }
}

function setDpr(value: number) {
  Object.defineProperty(window, "devicePixelRatio", { value, configurable: true });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function canvases(): HTMLCanvasElement[] {
  return [...document.querySelectorAll("canvas")];
}

/** A copy of every pixel the canvas holds, as RGBA bytes. */
function pixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D context");
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data.slice();
}

function isBlank(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("Orb motion", () => {
  it("A1: holds one still frame under reduced motion", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    render(() => <Orb state="working" size={64} />);
    await frames(2);
    const [canvas] = canvases();
    const first = pixels(canvas);
    await frames(20);
    expect(isBlank(first)).toBe(false);
    expect(same(first, pixels(canvas))).toBe(true);
  });

  it("A2: follows a change of the motion preference both ways", async () => {
    render(() => <Orb state="working" size={64} />);
    await frames(5);
    await emulateMedia({ reducedMotion: "reduce" });
    await frames(3);
    const [moving] = canvases();
    const held = pixels(moving);
    await frames(10);
    expect(same(held, pixels(moving))).toBe(true);

    // The frame it holds is the still frame a fresh orb draws.
    render(() => <Orb state="working" size={64} />);
    await frames(2);
    const fresh = canvases()[1];
    expect(same(held, pixels(fresh))).toBe(true);

    await emulateMedia({ reducedMotion: "no-preference" });
    await frames(10);
    expect(same(held, pixels(moving))).toBe(false);
  });

  it("A3: moves when motion is allowed", async () => {
    render(() => <Orb state="working" size={64} />);
    await frames(3);
    const [canvas] = canvases();
    const before = pixels(canvas);
    await frames(10);
    const after = pixels(canvas);
    expect(isBlank(before)).toBe(false);
    expect(isBlank(after)).toBe(false);
    expect(same(before, after)).toBe(false);
  });

  it("A4: stops painting off screen, and starts again on screen", async () => {
    render(() => (
      <div>
        <div style={{ height: "300vh" }} />
        <Orb state="working" size={64} />
      </div>
    ));
    await frames(5);
    const [canvas] = canvases();
    const parked = pixels(canvas);
    expect(isBlank(parked)).toBe(false);
    await frames(10);
    expect(same(parked, pixels(canvas))).toBe(true);

    canvas.scrollIntoView();
    await frames(10);
    expect(same(parked, pixels(canvas))).toBe(false);
  });

  it("A5: stops painting in a hidden tab, and starts again when shown", async () => {
    render(() => <Orb state="working" size={64} />);
    await frames(5);
    setVisibility("hidden");
    await frames(2);
    const [canvas] = canvases();
    const parked = pixels(canvas);
    await frames(10);
    expect(same(parked, pixels(canvas))).toBe(true);

    setVisibility("visible");
    await frames(10);
    expect(same(parked, pixels(canvas))).toBe(false);
  });

  it("A6: keeps two orbs of one state and size in the same phase", async () => {
    render(() => <Orb state="working" size={64} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    render(() => <Orb state="working" size={64} />);
    await frames(5);
    const [a, b] = canvases();
    expect(isBlank(pixels(a))).toBe(false);
    expect(same(pixels(a), pixels(b))).toBe(true);
  });

  it("A6b: draws each orb its own state's frame when several move at once", async () => {
    render(() => (
      <>
        <Orb state="working" size={64} />
        <Orb state="searching" size={64} />
        <Orb state="working" size={20} />
      </>
    ));
    await frames(5);
    const [working, searching, small] = canvases();
    expect(same(pixels(working), pixels(searching))).toBe(false);
    expect(small.width).not.toBe(working.width);
    expect(isBlank(pixels(small))).toBe(false);
  });

  it("A7: runs one loop for every orb", async () => {
    let calls = 0;
    window.requestAnimationFrame = (callback) => {
      calls++;
      return nativeRaf(callback);
    };
    render(() => (
      <>
        <Orb state="working" size={64} />
        <Orb state="searching" size={64} />
        <Orb state="shaping" size={20} />
      </>
    ));
    await frames(5);
    calls = 0;
    await frames(10);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(11);
  });

  it("A8: leaves no frame behind once the last orb unmounts", async () => {
    let calls = 0;
    let ran = 0;
    window.requestAnimationFrame = (callback) => {
      calls++;
      return nativeRaf((time) => {
        ran++;
        callback(time);
      });
    };
    render(() => <Orb state="working" size={64} />);
    await frames(5);
    expect(ran).toBeGreaterThan(0);

    cleanup();
    const callsAtUnmount = calls;
    const ranAtUnmount = ran;
    await frames(3);
    expect(ran).toBe(ranAtUnmount);
    expect(calls).toBe(callsAtUnmount);
  });

  it("A8b: keeps following the motion preference after one of two orbs unmounts", async () => {
    const [both, setBoth] = createSignal(true);
    render(() => (
      <>
        <Orb state="working" size={64} />
        <Show when={both()}>
          <Orb state="working" size={64} />
        </Show>
      </>
    ));
    await frames(5);
    setBoth(false);
    await frames(2);
    const [left] = canvases();
    expect(canvases()).toHaveLength(1);

    await emulateMedia({ reducedMotion: "reduce" });
    await frames(3);
    const held = pixels(left);
    await frames(10);
    expect(same(held, pixels(left))).toBe(true);

    render(() => <Orb state="working" size={64} />);
    await frames(2);
    expect(same(held, pixels(canvases()[1]))).toBe(true);
  });

  it("A16: holds its still frame once it has moved for five seconds, and asks for no more frames", async () => {
    let calls = 0;
    window.requestAnimationFrame = (callback) => {
      calls++;
      return nativeRaf(callback);
    };
    render(() => <Orb state="working" size={64} />);
    await frames(3);
    const [canvas] = canvases();
    const early = pixels(canvas);
    await frames(5);
    expect(same(early, pixels(canvas))).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5300));
    await frames(2);
    const settled = pixels(canvas);
    calls = 0;
    await frames(10);
    expect(same(settled, pixels(canvas))).toBe(true);
    expect(calls).toBe(0);

    // The frame it holds is the still frame reduced motion draws.
    await emulateMedia({ reducedMotion: "reduce" });
    render(() => <Orb state="working" size={64} />);
    await frames(2);
    expect(same(settled, pixels(canvases()[1]))).toBe(true);
  }, 15_000);
});

describe("Orb bitmap", () => {
  it("A9: caps the backing store at twice the CSS size", async () => {
    for (const [dpr, width] of [
      [3, 128],
      [1, 64],
      [1.5, 96],
    ] as const) {
      setDpr(dpr);
      render(() => <Orb size={64} />);
      const [canvas] = canvases();
      expect(canvas.width, `devicePixelRatio ${dpr}`).toBe(width);
      expect(canvas.height, `devicePixelRatio ${dpr}`).toBe(width);
      cleanup();
    }
  });

  it("A10: draws a 20px and a 64px box", () => {
    render(() => (
      <>
        <Orb size={20} />
        <Orb size={64} />
      </>
    ));
    const [small, large] = canvases().map((c) => c.getBoundingClientRect());
    expect([small.width, small.height]).toEqual([20, 20]);
    expect([large.width, large.height]).toEqual([64, 64]);
  });

  it("A10b: sizes the bitmap from the box when the root font size moves it", async () => {
    document.documentElement.style.fontSize = "20px";
    setDpr(2);
    render(() => <Orb size={20} />);
    await frames(2);
    const [canvas] = canvases();
    expect(canvas.getBoundingClientRect().width).toBe(25);
    expect(canvas.width).toBe(50);
  });

  it("A10c: refits the bitmap when a mounted orb changes size", async () => {
    setDpr(2);
    await emulateMedia({ reducedMotion: "reduce" });
    const [size, setSize] = createSignal<20 | 64>(20);
    render(() => <Orb size={size()} />);
    await frames(2);
    const [canvas] = canvases();
    expect(canvas.width).toBe(40);

    setSize(64);
    await frames(2);
    const box = canvas.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([64, 64]);
    expect([canvas.width, canvas.height]).toEqual([128, 128]);

    render(() => <Orb size={64} />);
    await frames(2);
    expect(same(pixels(canvas), pixels(canvases()[1]))).toBe(true);
  });

  it("A10d: sits in a line of text without breaking it", () => {
    render(() => (
      <p style={{ width: "400px" }}>
        Saving <Orb size={20} /> now
      </p>
    ));
    const [canvas] = canvases();
    const line = canvas.parentElement?.getBoundingClientRect();
    expect(line?.height).toBeLessThan(40);
    expect(getComputedStyle(canvas).verticalAlign).toBe("middle");
  });
});

describe("Orb ink and state", () => {
  it("A11: draws its ink in the colour it inherits, mirrored for a light colour", async () => {
    // Twice the pixels, and the state with the most solid dots: the mirror is
    // only exact where a pixel is nearly opaque, since the canvas stores
    // colour premultiplied by alpha in eight bits.
    setDpr(2);
    await emulateMedia({ reducedMotion: "reduce" });
    render(() => (
      <>
        <span style={{ color: "rgb(0, 0, 0)" }}>
          <Orb state="composing" size={64} />
        </span>
        <span style={{ color: "rgb(255, 255, 255)" }}>
          <Orb state="composing" size={64} />
        </span>
      </>
    ));
    await frames(2);
    const [light, dark] = canvases().map(pixels);
    // Black ink fades its far dots toward white, `g = w × 255`; white ink, a
    // light colour, fades them toward black, `(1 − w) × 255`, at the same
    // alpha. So each nearly opaque pixel of one is 255 minus the other's,
    // give or take the rounding of stacked translucent dots (measured: mean
    // 0.9, worst 8). Ignoring the colour would leave the two equal, a mean
    // error near 120.
    let opaque = 0;
    let errorSum = 0;
    let worst = 0;
    let lightSum = 0;
    let darkSum = 0;
    for (let i = 0; i < light.length; i += 4) {
      if (light[i + 3] <= 200) continue;
      const error = Math.abs(dark[i] - (255 - light[i]));
      opaque++;
      errorSum += error;
      worst = Math.max(worst, error);
      lightSum += light[i];
      darkSum += dark[i];
    }
    expect(opaque).toBeGreaterThan(100);
    expect(errorSum / opaque).toBeLessThanOrEqual(2);
    expect(worst).toBeLessThanOrEqual(12);
    expect(darkSum / opaque).toBeGreaterThan(lightSum / opaque);
  });

  it("A11b: tints its dots with a coloured ink rather than drawing grey", async () => {
    setDpr(2);
    await emulateMedia({ reducedMotion: "reduce" });
    render(() => (
      <span style={{ color: "rgb(200, 30, 30)" }}>
        <Orb state="composing" size={64} />
      </span>
    ));
    await frames(2);
    const drawn = pixels(canvases()[0]);
    let opaque = 0;
    let red = 0;
    for (let i = 0; i < drawn.length; i += 4) {
      if (drawn[i + 3] <= 200) continue;
      opaque++;
      if (drawn[i] > drawn[i + 1] + 60) red++;
    }
    expect(opaque).toBeGreaterThan(100);
    expect(red / opaque).toBeGreaterThan(0.9);
  });

  it("A11c: a still orb follows a change of colour on the root element", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    document.documentElement.style.color = "rgb(0, 0, 0)";
    render(() => <Orb state="composing" size={64} />);
    await frames(2);
    const [canvas] = canvases();
    const before = pixels(canvas);

    document.documentElement.style.color = "rgb(255, 255, 255)";
    await frames(2);
    const after = pixels(canvas);
    expect(same(before, after)).toBe(false);

    render(() => <Orb state="composing" size={64} />);
    await frames(2);
    expect(same(after, pixels(canvases()[1]))).toBe(true);
  });

  it("A12: draws a different still frame for each of the nine states, and follows a change", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    render(() => <For each={STATES}>{(state) => <Orb state={state} size={64} />}</For>);
    await frames(2);
    const stills = canvases().map(pixels);
    const blank = STATES.filter((_, i) => isBlank(stills[i]));
    const alike: string[] = [];
    for (let i = 0; i < stills.length; i++) {
      for (let j = i + 1; j < stills.length; j++) {
        if (same(stills[i], stills[j])) alike.push(`${STATES[i]} = ${STATES[j]}`);
      }
    }
    expect(stills).toHaveLength(9);
    expect(blank).toEqual([]);
    expect(alike).toEqual([]);
    cleanup();

    const [state, setState] = createSignal<OrbState>("working");
    render(() => <Orb state={state()} size={64} />);
    await frames(2);
    const [canvas] = canvases();
    const before = pixels(canvas);
    setState("searching");
    await frames(2);
    expect(same(before, pixels(canvas))).toBe(false);
  });

  it("A15: clears the canvas before each paint", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    const [state, setState] = createSignal<OrbState>("working");
    render(() => <Orb state={state()} size={64} />);
    await frames(2);
    setState("searching");
    render(() => <Orb state="searching" size={64} />);
    await frames(2);
    const [changed, fresh] = canvases().map(pixels);
    expect(same(changed, fresh)).toBe(true);
  });
});

describe("Orb in the accessibility tree", () => {
  it("A13: is hidden, unnamed and not focusable", () => {
    render(() => (
      <button type="button">
        <Orb size={20} />
        Creating…
      </button>
    ));
    const [canvas] = canvases();
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.getAttribute("role")).toBeNull();
    expect(canvas.getAttribute("aria-label")).toBeNull();
    expect(canvas.tabIndex).toBe(-1);
    canvas.focus();
    expect(document.activeElement).not.toBe(canvas);
  });
});

describe("Orb still frames", () => {
  it("writes the nine still frames at 20 and 64 on a light and a dark ground", async () => {
    // Wide enough for nine 64px orbs in a row; the test frame is phone-width
    // by default and an element screenshot is clipped to it.
    await page.viewport(800, 400);
    await emulateMedia({ reducedMotion: "reduce" });
    for (const dark of [false, true]) {
      render(() => (
        <div
          data-testid="sheet"
          class={`inline-flex flex-col gap-3 p-4 ${dark ? "bg-ui-ink text-ui-ground" : "bg-ui-ground text-ui-ink"}`}
        >
          <For each={[64, 20] as const}>
            {(size) => (
              <div class="flex items-center gap-3">
                <For each={STATES}>{(state) => <Orb state={state} size={size} />}</For>
              </div>
            )}
          </For>
        </div>
      ));
      await frames(2);
      const drawn = canvases().map(pixels);
      expect(drawn).toHaveLength(18);
      expect(drawn.filter(isBlank)).toEqual([]);
      await page.screenshot({
        path: `${SHOTS}/still-frames-${dark ? "dark" : "light"}.png`,
        element: page.getByTestId("sheet"),
      });
      cleanup();
    }
  });
});
