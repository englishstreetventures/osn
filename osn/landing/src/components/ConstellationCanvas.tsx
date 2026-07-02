import { onCleanup, onMount } from "solid-js";

// The signature OSN backdrop: an animated network/constellation of dots — nodes
// with thin lines drawn between near neighbours, evoking a social graph. It sits
// behind all content (z-index:-1, pointer-events:none, low opacity) and spans
// the full page height.
//
// Reduced motion / no-JS: renders a single still field (no rAF loop). Otherwise
// nodes drift gently and the linking lines fade with distance. Node count is
// capped relative to viewport area so large pages stay cheap; the loop is torn
// down in onCleanup.

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const LINK_DIST = 132; // px — link nodes closer than this
const MAX_NODES = 120; // hard cap regardless of area
const AREA_PER_NODE = 18000; // one node per ~this many px² of viewport

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function ConstellationCanvas() {
  let canvasRef!: HTMLCanvasElement;

  onMount(() => {
    const canvas = canvasRef;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cssW = 0;
    let cssH = 0;
    let nodes: Node[] = [];
    let raf = 0;
    const reduced = prefersReducedMotion();

    // Resolve the accent colour once from the computed theme so the canvas stays
    // in sync with the CSS tokens (avoids hard-coding the oklch values here).
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue("--color-accent").trim() || "oklch(0.7 0.14 250)";
    const line = styles.getPropertyValue("--color-border").trim() || "rgba(255,255,255,0.1)";

    function buildNodes() {
      const target = Math.min(MAX_NODES, Math.floor((cssW * cssH) / AREA_PER_NODE));
      nodes = [];
      for (let i = 0; i < target; i++) {
        nodes.push({
          x: Math.random() * cssW,
          y: Math.random() * cssH,
          vx: (Math.random() - 0.5) * 0.12,
          vy: (Math.random() - 0.5) * 0.12,
          r: 1 + Math.random() * 1.6,
        });
      }
    }

    // Arrow consts (not hoisted `function` declarations) so TS keeps the
    // non-null narrowing of `ctx` from the guard above inside these closures.
    // Size the backing store to the VIEWPORT (the layer is `position: fixed`), so
    // it stays a few MB regardless of page length. Cheap — no node rebuild.
    const fit = () => {
      cssW = document.documentElement.clientWidth;
      cssH = window.innerHeight;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      ctx.clearRect(0, 0, cssW, cssH);

      // Links first (under the nodes).
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < LINK_DIST) {
            const alpha = (1 - d / LINK_DIST) * 0.5;
            ctx.strokeStyle = line;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Nodes.
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = accent;
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    function step() {
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > cssW) n.vx *= -1;
        if (n.y < 0 || n.y > cssH) n.vy *= -1;
      }
      draw();
      raf = requestAnimationFrame(step);
    }

    fit();
    buildNodes();

    if (reduced) {
      // Still field — render once, no animation loop.
      draw();
    } else {
      raf = requestAnimationFrame(step);
    }

    // Always refit the canvas to the viewport (rotation, mobile URL bar), but
    // only reshuffle the nodes on a real WIDTH change so the field doesn't jump
    // mid-scroll when the URL bar toggles height.
    let lastW = cssW;
    let resizeTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fit();
        if (Math.abs(document.documentElement.clientWidth - lastW) >= 24) {
          lastW = document.documentElement.clientWidth;
          buildNodes();
        }
        if (reduced) draw();
      }, 200);
    };
    window.addEventListener("resize", onResize, { passive: true });

    // Pause the loop while the tab is hidden (belt-and-suspenders on top of the
    // browser's own background-rAF throttling); resume on return.
    const onVisibility = () => {
      if (reduced) return;
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        raf = requestAnimationFrame(step);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    onCleanup(() => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    });
  });

  return (
    <div class="constellation-layer" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
