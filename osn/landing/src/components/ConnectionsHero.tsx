import { onCleanup, onMount } from "solid-js";

interface ConnectionsHeroProps {
  /** Primary CTA target — the OSN identity / social app. */
  appUrl: string;
  /** Secondary CTA — an in-page anchor (e.g. "#apps"). */
  exploreHref: string;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Hero node layout in normalized [0,1] coords — a small social graph: a central
// "you" node ringed by connections. Edges link the centre to each ring node and
// a few ring nodes to each other, so it reads as a graph, not a star.
const CENTER = { x: 0.5, y: 0.5 };
const RING: { x: number; y: number }[] = [
  { x: 0.22, y: 0.26 },
  { x: 0.78, y: 0.22 },
  { x: 0.86, y: 0.58 },
  { x: 0.7, y: 0.82 },
  { x: 0.3, y: 0.84 },
  { x: 0.14, y: 0.58 },
];
// Extra ring-to-ring edges (indices into RING) so the graph has texture.
const RING_EDGES: [number, number][] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [1, 2],
];

/**
 * The hero. A small graph of person-nodes whose edges draw in on mount, behind
 * and around the headline — dramatizing "connections". The headline emphasises
 * ownership of identity + social graph. Two CTAs: primary "Get started" and a
 * secondary in-page "Explore the ecosystem" anchor.
 *
 * Reduced motion / no-JS: the graph snaps to its fully-drawn state and the loop
 * never starts. Keyboard-accessible (real <a> CTAs, visible focus styles).
 */
export function ConnectionsHero(props: ConnectionsHeroProps) {
  let canvasRef!: HTMLCanvasElement;

  onMount(() => {
    const canvas = canvasRef;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    let raf = 0;
    const reduced = prefersReducedMotion();

    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue("--color-accent").trim() || "oklch(0.7 0.14 250)";
    const accent2 = styles.getPropertyValue("--color-accent-2").trim() || "oklch(0.78 0.12 205)";
    const line = styles.getPropertyValue("--color-border").trim() || "rgba(255,255,255,0.12)";

    function pt(n: { x: number; y: number }) {
      // Map normalized coords into the canvas with a margin so nodes never clip.
      const m = 0.12;
      return { x: (m + n.x * (1 - 2 * m)) * w, y: (m + n.y * (1 - 2 * m)) * h };
    }

    // All edges as ordered point pairs, drawn progressively by `progress` 0→1.
    type Edge = { a: { x: number; y: number }; b: { x: number; y: number } };
    let edges: Edge[] = [];

    function rebuildEdges() {
      const c = pt(CENTER);
      const ring = RING.map(pt);
      edges = [];
      for (const r of ring) edges.push({ a: c, b: r });
      for (const [i, j] of RING_EDGES) edges.push({ a: ring[i], b: ring[j] });
    }

    // Arrow consts (not hoisted `function` declarations) so TS keeps the
    // non-null narrowing of `ctx` from the guard above inside these closures.
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuildEdges();
    };

    const drawNode = (p: { x: number; y: number }, radius: number, fill: string) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
    };

    // progress: 0 → 1 across edge draw-in, then nodes pop.
    const render = (progress: number) => {
      ctx.clearRect(0, 0, w, h);
      const eased = progress * progress * (3 - 2 * progress); // smoothstep

      // Edges draw in sequentially as progress advances.
      const per = 1 / edges.length;
      ctx.lineWidth = 1.4;
      for (let i = 0; i < edges.length; i++) {
        const start = i * per;
        const local = Math.min(1, Math.max(0, (eased - start) / per));
        if (local <= 0) continue;
        const { a, b } = edges[i];
        ctx.strokeStyle = line;
        ctx.globalAlpha = 0.4 + 0.6 * local;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (b.x - a.x) * local, a.y + (b.y - a.y) * local);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Nodes fade/scale in once their edges are mostly drawn.
      const nodeAlpha = Math.min(1, Math.max(0, (eased - 0.35) / 0.65));
      ctx.globalAlpha = nodeAlpha;
      const ring = RING.map(pt);
      for (const r of ring) drawNode(r, 4 + 2 * nodeAlpha, accent2);
      drawNode(pt(CENTER), 7 + 3 * nodeAlpha, accent);
      ctx.globalAlpha = 1;
    };

    resize();

    if (reduced) {
      render(1);
    } else {
      const duration = 1600;
      const t0 = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - t0) / duration);
        render(progress);
        if (progress < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    let resizeTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resize();
        render(1); // after a resize, settle on the final drawn state
      }, 150);
    };
    window.addEventListener("resize", onResize, { passive: true });

    onCleanup(() => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
    });
  });

  return (
    <section
      class="relative flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-6 py-24 text-center"
      aria-label="OSN — your social graph, your control"
    >
      {/* The connections graph, behind the headline. */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 -z-10 h-full w-full opacity-70"
      />
      <div
        aria-hidden="true"
        class="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2"
        style={{
          background: "radial-gradient(circle, var(--color-accent-dim), transparent 62%)",
        }}
      />

      <div class="relative mx-auto w-full max-w-[48rem]">
        <p class="font-body text-accent mb-5 text-[0.74rem] font-medium tracking-[0.26em] uppercase">
          Open Social Network
        </p>
        <h1 class="font-display text-text text-[clamp(2.1rem,7.5vw,5rem)] leading-[1.05] font-bold tracking-[-0.02em] text-balance">
          Your social graph,
          <br />
          your control.
        </h1>
        <p class="font-body text-text-muted mx-auto mt-6 max-w-[36rem] text-[1.05rem] leading-[1.7]">
          OSN decouples your identity and relationships from the apps that use them. Own your
          connections, set your rules once, and switch on only the apps you want — they never get to
          keep your graph.
        </p>
        <div class="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={props.appUrl}
            class="border-accent bg-accent text-bg hover:text-accent font-body w-full rounded-md border px-7 py-3.5 text-[0.9rem] font-medium tracking-[0.02em] transition-colors duration-200 hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 sm:w-auto"
          >
            Get started
          </a>
          <a
            href={props.exploreHref}
            class="border-border font-body text-text hover:border-accent hover:text-accent w-full rounded-md border bg-transparent px-7 py-3.5 text-[0.9rem] font-medium tracking-[0.02em] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 sm:w-auto"
          >
            Explore the ecosystem
          </a>
        </div>
      </div>
    </section>
  );
}
