import { createSignal, For, onCleanup, onMount } from "solid-js";

import { generateField, type VineField } from "../lib/vines/generate";
import { randomSeed } from "../lib/vines/prng";

// Generative botanical backdrop. Vines emerge from the left/right page edges,
// meander down and inward, curl into tendrils and carry leaves + flowers — and
// "grow" (draw on) as you scroll past them.
//
// SSR / no-JS: a deterministic field at a default size renders fully-drawn and
// static (this is the "roots + start points, server-rendered" baseline). On
// mount the client measures the real document, regenerates with a FRESH per-load
// seed (so every visit is unique), and drives each vine's growth from scroll via
// a single CSS custom property `--p` (0→1) — cheap, one write per in-view vine
// per frame. Reduced motion shows the vines fully drawn, no growth.

// SSR baseline size — replaced by the real measured size on mount.
const SSR_W = 1280;
const SSR_H = 4200;
// Fraction down the viewport that the "growth front" follows.
const TRIGGER = 0.82;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function VineCanvas() {
  const [field, setField] = createSignal<VineField>(
    generateField("cire-ssr-baseline", SSR_W, SSR_H),
  );
  const [animated, setAnimated] = createSignal(false);
  let layerRef!: HTMLDivElement;

  onMount(() => {
    // A fresh per-load seed, kept STABLE across resizes so a genuine resize
    // re-lays-out the same plant rather than reshuffling into a new one.
    const seed = randomSeed();
    let lastW = 0;

    // Regenerate at the real document size.
    const regen = () => {
      const w = document.documentElement.clientWidth;
      const h = Math.max(document.documentElement.scrollHeight, window.innerHeight);
      lastW = w;
      setField(generateField(seed, w, h));
    };
    regen();
    setAnimated(true);

    if (prefersReducedMotion()) return; // CSS leaves the field fully drawn

    let ticking = false;
    const update = () => {
      ticking = false;
      const front = window.scrollY + window.innerHeight * TRIGGER;
      const groups = layerRef.querySelectorAll<SVGGElement>("[data-vine]");
      for (const g of groups) {
        const top = Number(g.dataset.top);
        const span = Math.max(1, Number(g.dataset.bottom) - top);
        const p = Math.min(1, Math.max(0, (front - top) / span)).toFixed(3);
        // Skip redundant writes: a vine whose progress is unchanged (any
        // off-screen vine pinned at 0 or 1) needs no style recalc or repaint —
        // this bounds per-frame paint to the few vines crossing the front.
        if (g.dataset.p === p) continue;
        g.dataset.p = p;
        g.style.setProperty("--p", p);
      }
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };

    let resizeTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        // Only rebuild on a real WIDTH change. Height-only resizes (the mobile
        // URL bar showing/hiding during scroll) must NOT trigger the costly full
        // regenerate + SVG rebuild mid-interaction; re-run growth either way.
        if (Math.abs(document.documentElement.clientWidth - lastW) >= 24) regen();
        requestAnimationFrame(update);
      }, 200);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    onCleanup(() => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(resizeTimer);
    });

    // First paint at the correct scroll position (avoids a grow-from-zero flash).
    requestAnimationFrame(update);
  });

  return (
    <div
      ref={layerRef}
      class="vine-layer"
      classList={{ "is-animated": animated() }}
      aria-hidden="true"
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${field().width} ${field().height}`}
        preserveAspectRatio="none"
      >
        <For each={field().vines}>
          {(vine) => (
            <g
              data-vine
              data-top={vine.top}
              data-bottom={vine.bottom}
              style={{ "--p": animated() ? "0" : "1" }}
            >
              <For each={vine.strands}>
                {(strand) => (
                  <path
                    class="vine-stroke"
                    d={strand.d}
                    pathLength="1"
                    style={{ "--a0": strand.a0, "--a1": strand.a1 }}
                  />
                )}
              </For>
              <g class="vine-organs">
                <For each={vine.leaves}>
                  {(leaf) => <path class="vine-leaf" d={leaf.d} style={{ "--a": leaf.a }} />}
                </For>
                <For each={vine.flowers}>
                  {(flower) => (
                    <g style={{ "--a": flower.a }}>
                      <For each={flower.petals}>{(d) => <path class="vine-petal" d={d} />}</For>
                      <circle class="vine-heart" cx={flower.cx} cy={flower.cy} r={flower.cr} />
                    </g>
                  )}
                </For>
              </g>
            </g>
          )}
        </For>
      </svg>
    </div>
  );
}
