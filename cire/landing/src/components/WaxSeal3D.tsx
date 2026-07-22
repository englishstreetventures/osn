import { createSignal, onCleanup, onMount } from "solid-js";

import type { WaxSealController } from "./waxSealScene";

// The seal PRESENTER. It is purely decorative: the hero's headline and calls to
// action are server-rendered siblings of this island (see sections/Hero.astro),
// so if this never hydrates — no JS, no WebGL, an error in Three.js — the page
// still reads and converts. This component only ever upgrades the picture of the
// seal from a flat CSS disc to a lit, three-dimensional one.
//
// Baseline (always in the DOM): a gold CSS disc with the embossed "C". It is the
// static poster the visitor sees first and the no-WebGL / no-JS fallback. On a
// WebGL-capable client we lazy-load the Three.js scene, mount it on the <canvas>
// layered on top, and cross-fade it in once its first frame paints. Visitors
// preferring reduced motion get the same 3D seal as a motionless still life.

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function supportsWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(
      window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")),
    );
  } catch {
    return false;
  }
}

export function WaxSeal3D() {
  let canvasRef!: HTMLCanvasElement;
  // `live` flips true once the 3D scene's FIRST FRAME has painted — only then
  // does the poster fade out (cross-fading with the canvas fading in). The
  // poster is never hidden on the mere promise of a 3D seal: if the deferred
  // import 404s, the WebGL context dies, or the first frame never comes, the
  // visitor keeps the gold poster instead of an empty hole in the hero.
  const [live, setLive] = createSignal(false);

  onMount(() => {
    if (!supportsWebGL()) return; // poster stands in

    // Reduced motion doesn't mean no 3D — it means no MOTION. Those visitors
    // get the same lit, embossed seal as a still life (single frame, no
    // settle, no pointer lean).
    const still = prefersReducedMotion();

    let controller: WaxSealController | undefined;
    let cancelled = false;

    // Defer the heavy import to idle time so it never competes with first paint.
    const load = async () => {
      try {
        const { mountWaxSeal } = await import("./waxSealScene");
        if (cancelled) return;
        controller = mountWaxSeal(canvasRef, { onReady: () => setLive(true), still });
      } catch {
        // Decorative upgrade failed — the poster is still on screen; done.
      }
    };
    const win = window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
    };
    if (typeof win.requestIdleCallback === "function") win.requestIdleCallback(() => void load());
    else window.setTimeout(() => void load(), 200);

    onCleanup(() => {
      cancelled = true;
      controller?.destroy();
    });
  });

  return (
    <div class="seal-stage" aria-hidden="true">
      {/* Faint gold bloom the seal rests in — present in every mode. */}
      <div class="seal-glow" />

      {/* Static poster: a pressed gold wax disc. The no-WebGL / no-JS fallback;
          stays visible until the 3D seal's first frame is actually on screen. */}
      <div class="seal-poster" classList={{ "is-hidden": live() }}>
        <span class="seal-monogram">C</span>
      </div>

      {/* Three.js target. Transparent until the scene's first frame arrives. */}
      <canvas ref={canvasRef} class="seal-canvas" classList={{ "is-live": live() }} />

      <style>{`
        .seal-stage {
          position: relative;
          width: clamp(13rem, 42vw, 20rem);
          height: clamp(13rem, 42vw, 20rem);
          margin-inline: auto;
          isolation: isolate;
        }
        .seal-glow {
          position: absolute;
          inset: -40%;
          z-index: -1;
          background: radial-gradient(
            circle,
            oklch(74.99% 0.0854 82.08 / 0.32),
            transparent 62%
          );
          pointer-events: none;
        }
        .seal-poster,
        .seal-canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        .seal-poster {
          display: grid;
          place-items: center;
          border-radius: 50%;
          background: radial-gradient(
            circle at 38% 32%,
            oklch(82% 0.09 82.08),
            oklch(63% 0.085 70) 68%,
            oklch(52% 0.08 64)
          );
          box-shadow:
            inset 0 3px 6px oklch(95% 0.05 82 / 0.5),
            inset 0 -6px 12px oklch(40% 0.06 60 / 0.6),
            0 14px 40px oklch(0% 0 0 / 0.45);
          transition: opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .seal-poster.is-hidden {
          opacity: 0;
        }
        .seal-monogram {
          font-family: var(--font-display, "Cormorant Garamond", Georgia, serif);
          font-size: clamp(5rem, 18vw, 8rem);
          font-style: italic;
          line-height: 1;
          color: oklch(30% 0.04 80);
          transform: translateY(0.04em);
        }
        .seal-canvas {
          opacity: 0;
          transition: opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .seal-canvas.is-live {
          opacity: 1;
        }
        @media (prefers-reduced-motion: reduce) {
          .seal-poster,
          .seal-canvas {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}
