import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WaxSeal3D } from "./WaxSeal3D";
import type { WaxSealOptions } from "./waxSealScene";

// The scene module is WebGL-bound and can't run under happy-dom — but every
// behaviour this island owns (poster gating, failure fallback, reduced-motion
// still mode, disposal) lives at the seam between the island and the scene,
// so mocking the seam covers the lot.
const { mountWaxSeal } = vi.hoisted(() => ({ mountWaxSeal: vi.fn() }));
vi.mock("./waxSealScene", () => ({ mountWaxSeal }));

function poster(container: HTMLElement): HTMLElement {
  return container.querySelector(".seal-poster") as HTMLElement;
}

function stubWebGL() {
  vi.stubGlobal("WebGLRenderingContext", class {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
}

/** Make the deferred idle-time load run immediately. */
function runIdleNow() {
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
    cb();
    return 1;
  });
}

describe("WaxSeal3D", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mountWaxSeal.mockReset();
  });

  it("keeps the poster and never loads the scene without WebGL", async () => {
    vi.stubGlobal("WebGLRenderingContext", undefined);
    const { container } = render(() => <WaxSeal3D />);
    await Promise.resolve();
    expect(poster(container).classList.contains("is-hidden")).toBe(false);
    expect(mountWaxSeal).not.toHaveBeenCalled();
  });

  it("hides the poster only after the scene's first frame, not on load-commit", async () => {
    stubWebGL();
    runIdleNow();
    let onReady: (() => void) | undefined;
    mountWaxSeal.mockImplementation((_canvas: HTMLCanvasElement, opts: WaxSealOptions) => {
      onReady = opts.onReady;
      return { destroy: vi.fn() };
    });
    const { container } = render(() => <WaxSeal3D />);
    await waitFor(() => expect(mountWaxSeal).toHaveBeenCalled());

    // Scene mounted but no frame painted yet — the poster must still show.
    expect(poster(container).classList.contains("is-hidden")).toBe(false);

    onReady!();
    await waitFor(() => expect(poster(container).classList.contains("is-hidden")).toBe(true));
  });

  it("keeps the poster when mounting the scene throws", async () => {
    stubWebGL();
    runIdleNow();
    mountWaxSeal.mockImplementation(() => {
      throw new Error("context lost");
    });
    const { container } = render(() => <WaxSeal3D />);
    await waitFor(() => expect(mountWaxSeal).toHaveBeenCalled());
    expect(poster(container).classList.contains("is-hidden")).toBe(false);
  });

  it("passes still: true under prefers-reduced-motion — 3D, no motion", async () => {
    stubWebGL();
    runIdleNow();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
    }));
    mountWaxSeal.mockReturnValue({ destroy: vi.fn() });
    render(() => <WaxSeal3D />);
    await waitFor(() =>
      expect(mountWaxSeal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ still: true }),
      ),
    );
  });

  it("passes still: false for motion-happy visitors", async () => {
    stubWebGL();
    runIdleNow();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    mountWaxSeal.mockReturnValue({ destroy: vi.fn() });
    render(() => <WaxSeal3D />);
    await waitFor(() =>
      expect(mountWaxSeal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ still: false }),
      ),
    );
  });

  it("destroys the scene controller on unmount", async () => {
    stubWebGL();
    runIdleNow();
    const destroy = vi.fn();
    mountWaxSeal.mockReturnValue({ destroy });
    render(() => <WaxSeal3D />);
    await waitFor(() => expect(mountWaxSeal).toHaveBeenCalled());
    cleanup();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("never mounts the scene when unmounted before the idle callback fires", async () => {
    stubWebGL();
    let idle: (() => void) | undefined;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idle = cb;
      return 1;
    });
    render(() => <WaxSeal3D />);
    cleanup();
    idle?.();
    // Let the (mocked) dynamic import settle before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(mountWaxSeal).not.toHaveBeenCalled();
  });
});
