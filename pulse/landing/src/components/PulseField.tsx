import { createSignal, For, onCleanup, onMount } from "solid-js";

// Signature background visual — an animated field of colourful pulsing dots and
// radiating rings, echoing the app's "pulsing coral dot" mark and the
// welcome-pulse rings from DESIGN.md (but multi-coloured). Sits behind all
// content at low opacity, never intercepts pointer events, spans the full page
// height.
//
// SSR / no-JS: a deterministic field renders fully and static. On mount the
// client measures the document and (unless reduced motion is requested) drives a
// gentle per-dot pulse + occasional ring ripple from a single rAF loop, writing
// only CSS custom properties — cheap, no layout thrash. Reduced motion shows the
// still field with no rAF loop.

// The six category colours, addressed via the `--cat-*` tokens in global.css.
const COLORS = [
  "var(--cat-1)",
  "var(--cat-2)",
  "var(--cat-3)",
  "var(--cat-4)",
  "var(--cat-5)",
  "var(--cat-6)",
] as const;

// SSR baseline size — replaced by the real measured size on mount.
const SSR_W = 1280;
const SSR_H = 4200;

interface Dot {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly color: string;
  /** Phase offset (0–1) so dots don't pulse in lockstep. */
  readonly phase: number;
  /** Pulse speed multiplier. */
  readonly speed: number;
}

// A tiny deterministic PRNG (mulberry32) so the SSR field and the first client
// field agree, avoiding a hydration flash.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildDots(width: number, height: number, seed: number): Dot[] {
  const rand = mulberry32(seed);
  // Density scales with page area; clamped so very tall pages stay light.
  const target = Math.min(120, Math.max(28, Math.round((width * height) / 26000)));
  const dots: Dot[] = [];
  for (let i = 0; i < target; i++) {
    dots.push({
      cx: rand() * width,
      cy: rand() * height,
      r: 2 + rand() * 5,
      color: COLORS[Math.floor(rand() * COLORS.length)],
      phase: rand(),
      speed: 0.4 + rand() * 0.8,
    });
  }
  return dots;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function PulseField() {
  const [width, setWidth] = createSignal(SSR_W);
  const [height, setHeight] = createSignal(SSR_H);
  const [dots, setDots] = createSignal<Dot[]>(buildDots(SSR_W, SSR_H, 1));
  const [animated, setAnimated] = createSignal(false);
  let layerRef!: HTMLDivElement;

  // The animated node set only changes on regen() (a real width resize), so we
  // cache the SVG elements + their parsed speed/phase once and reuse them every
  // frame instead of re-walking the DOM 60×/sec.
  let dotEls: { el: SVGElement; speed: number; phase: number }[] = [];
  let ringEls: SVGElement[] = [];

  onMount(() => {
    const seed = (Math.floor(Math.random() * 0xffffffff) || 1) >>> 0;
    let lastW = 0;

    const recache = () => {
      dotEls = Array.from(layerRef.querySelectorAll<SVGElement>("[data-dot]")).map((el) => ({
        el,
        speed: Number(el.dataset.speed),
        phase: Number(el.dataset.phase),
      }));
      ringEls = Array.from(layerRef.querySelectorAll<SVGElement>("[data-ring]"));
    };

    const regen = () => {
      const w = document.documentElement.clientWidth;
      const h = Math.max(document.documentElement.scrollHeight, window.innerHeight);
      lastW = w;
      setWidth(w);
      setHeight(h);
      setDots(buildDots(w, h, seed));
      // Solid has applied the <For> DOM updates synchronously by here.
      recache();
    };
    regen();
    setAnimated(true);

    if (prefersReducedMotion()) return; // CSS leaves the field calm + static

    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (start === 0) start = now;
      const t = (now - start) / 1000;
      for (const { el, speed, phase } of dotEls) {
        const wave = Math.sin((t * speed + phase) * Math.PI * 2);
        el.style.setProperty("--s", (1 + wave * 0.18).toFixed(3));
        el.style.setProperty("--o", (0.42 + (wave + 1) * 0.18).toFixed(3));
      }
      // A few rings ripple outward on a slow shared cycle, staggered by index.
      for (let j = 0; j < ringEls.length; j++) {
        const cycle = (t * 0.35 + j * 0.5) % 1;
        ringEls[j].style.setProperty("--rs", (0.6 + cycle * 2.4).toFixed(3));
        ringEls[j].style.setProperty("--ro", Math.max(0, 0.5 - cycle * 0.5).toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    let resizeTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        // Only rebuild on a real WIDTH change; height-only resizes (mobile URL
        // bar) must not reshuffle the field mid-scroll.
        if (Math.abs(document.documentElement.clientWidth - lastW) >= 24) regen();
      }, 200);
    };
    window.addEventListener("resize", onResize, { passive: true });

    onCleanup(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(resizeTimer);
    });
  });

  // Every fourth dot also seeds a radiating ring, for the "welcome-pulse" ripple.
  const rings = () => dots().filter((_, i) => i % 4 === 0);

  return (
    <div
      ref={layerRef}
      class="pulse-layer"
      classList={{ "is-animated": animated() }}
      aria-hidden="true"
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${width()} ${height()}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <For each={rings()}>
          {(dot) => (
            <circle
              data-ring
              class="pulse-ring"
              cx={dot.cx}
              cy={dot.cy}
              r={dot.r * 2.4}
              stroke={dot.color}
              stroke-width="1.5"
              style={{ "--rs": "1", "--ro": "0" }}
            />
          )}
        </For>
        <For each={dots()}>
          {(dot) => (
            <circle
              data-dot
              class="pulse-dot"
              data-speed={dot.speed}
              data-phase={dot.phase}
              cx={dot.cx}
              cy={dot.cy}
              r={dot.r}
              fill={dot.color}
              style={{ "--s": "1", "--o": "0.5" }}
            />
          )}
        </For>
      </svg>
    </div>
  );
}
