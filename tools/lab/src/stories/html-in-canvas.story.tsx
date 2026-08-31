import { createEffect } from "solid-js";
import {
  AmbientLight,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type CanvasTexture,
} from "three";

import { Canvas2D, CSS3DObject, htmlToCanvas, htmlToTexture, ThreeCanvas } from "../lab/three.tsx";
import type { Story, StoryArgs } from "../lab/types.ts";

// `headless: false` — every story here builds a `WebGLRenderer`, which needs a
// GPU context no headless DOM provides. The smoke test imports the file and
// stops there.
export const meta = { title: "lab/html-in-canvas", layout: "fullscreen" as const, headless: false };

/**
 * The card markup all three stories rasterise. Written as strict XHTML —
 * every tag closed — because the SVG `foreignObject` route parses it as XML
 * and one unclosed tag kills the whole image. Styles are inline or in the
 * `css` block for the same reason: no stylesheet from the page reaches here.
 */
function cardHtml(title: string, subtitle: string, accent: string): string {
  return `
    <div class="card" style="border-color:${accent}">
      <div class="dot" style="background:${accent}"></div>
      <div class="title">${title}</div>
      <div class="subtitle">${subtitle}</div>
    </div>
  `;
}

const CARD_CSS = `
  .card {
    box-sizing: border-box;
    width: 420px; height: 220px;
    padding: 28px;
    border: 2px solid #000; border-radius: 20px;
    background: #ffffff;
    font-family: -apple-system, "SF Pro Text", Helvetica, Arial, sans-serif;
    color: #1c1c1c;
  }
  .dot { width: 14px; height: 14px; border-radius: 999px; margin-bottom: 18px; }
  .title { font-size: 30px; font-weight: 600; letter-spacing: -0.6px; }
  .subtitle { margin-top: 8px; font-size: 15px; color: #5d5d5d; line-height: 21px; }
`;

interface RasterArgs extends StoryArgs {
  title: string;
  subtitle: string;
  accent: string;
  wobble: number;
}

/**
 * HTML → 2D canvas. The card is rasterised once, then drawn every frame with
 * a canvas transform on it. Useful when you want DOM-authored artwork but
 * canvas-level control of how it is composited.
 */
export const Raster2D: Story<RasterArgs> = {
  args: {
    title: "Rasterised card",
    subtitle: "Authored as HTML, drawn as pixels.",
    accent: "#7c5cff",
    wobble: 0.35,
  },
  controls: { wobble: { kind: "range", min: 0, max: 1, step: 0.05 } },
  render: (args) => (
    <Canvas2D
      setup={({ ctx, onFrame }) => {
        let source: HTMLCanvasElement | undefined;
        // Re-rasterises whenever the text or colour changes. A raster is not
        // free, so this deliberately sits behind an effect rather than in the
        // frame loop.
        //
        // Rasters are async and nothing serialises them, so two quick edits can
        // finish out of order and leave the older one on screen. The counter
        // makes the newest request the only one allowed to land.
        let latest = 0;
        createEffect(() => {
          const html = cardHtml(args.title, args.subtitle, args.accent);
          const generation = ++latest;
          void (async () => {
            const next = await htmlToCanvas(html, { width: 420, height: 220, css: CARD_CSS });
            if (generation !== latest) return;
            source = next;
          })();
        });

        onFrame(({ elapsed, width, height }) => {
          ctx.clearRect(0, 0, width, height);
          if (!source) return;
          const angle = Math.sin(elapsed * 1.2) * args.wobble * 0.25;
          const scale = 1 + Math.sin(elapsed * 0.8) * args.wobble * 0.06;
          ctx.save();
          ctx.translate(width / 2, height / 2);
          ctx.rotate(angle);
          ctx.scale(scale, scale);
          ctx.drawImage(source, -210, -110, 420, 220);
          ctx.restore();
        });
      }}
    />
  ),
};

interface TextureArgs extends StoryArgs {
  title: string;
  accent: string;
  spin: number;
}

/**
 * HTML → three.js texture. Same raster, mapped onto a plane in a real 3D
 * scene. This is the cheap route: it is an image, so it cannot be clicked,
 * selected or focused — but it lights, shades and depth-sorts like any other
 * geometry.
 */
export const HtmlTexture: Story<TextureArgs> = {
  args: { title: "Textured plane", accent: "#00b894", spin: 0.5 },
  controls: { spin: { kind: "range", min: 0, max: 2, step: 0.05 } },
  render: (args) => (
    <ThreeCanvas
      setup={({ scene, camera, onFrame, onDispose }) => {
        const geometry = new PlaneGeometry(4.2, 2.2);
        const material = new MeshStandardMaterial({ side: DoubleSide, roughness: 0.9 });
        const mesh = new Mesh(geometry, material);
        scene.add(mesh);

        const key = new DirectionalLight(0xffffff, 2);
        key.position.set(2, 3, 4);
        scene.add(key, new AmbientLight(0xffffff, 0.7));
        camera.position.set(0, 0, 5);

        let texture: CanvasTexture | undefined;
        // Same ordering guard as Raster2D, and it matters more here: a stale
        // raster landing late would dispose the texture the material is
        // currently drawing, then assign the older one — a disposed texture on
        // screen, and the wrong content after it.
        let latest = 0;
        createEffect(() => {
          const html = cardHtml(args.title, "Rasterised into a CanvasTexture.", args.accent);
          const generation = ++latest;
          void (async () => {
            const next = await htmlToTexture(html, { width: 420, height: 220, css: CARD_CSS });
            if (generation !== latest) {
              next.dispose();
              return;
            }
            // Dispose the outgoing texture: a slider drag would otherwise
            // leave a trail of orphaned GPU uploads.
            texture?.dispose();
            texture = next;
            material.map = next;
            material.needsUpdate = true;
          })();
        });
        onDispose(() => texture?.dispose());

        onFrame(({ elapsed }) => {
          mesh.rotation.y = Math.sin(elapsed * args.spin) * 0.7;
          mesh.rotation.x = Math.sin(elapsed * args.spin * 0.6) * 0.2;
        });
      }}
    />
  ),
};

interface Css3dArgs extends StoryArgs {
  label: string;
  accent: string;
  spin: number;
}

/**
 * Real DOM in the 3D scene, via `CSS3DRenderer`. The card is a live element —
 * text selects, the button takes clicks, CSS transitions run — transformed by
 * the same camera as the WebGL layer. The trade is that it composites *over*
 * the canvas: it cannot be occluded by geometry, and it takes no lighting.
 * A WebGL plane behind it fakes the occlusion for a flat layout.
 */
export const Css3dLayer: Story<Css3dArgs> = {
  args: { label: "Click me", accent: "#e17055", spin: 0.4 },
  controls: { spin: { kind: "range", min: 0, max: 2, step: 0.05 } },
  render: (args) => (
    <ThreeCanvas
      css3d
      setup={({ scene, camera, css3dScene, onFrame, onDispose }) => {
        const element = document.createElement("div");
        // The CSS3D layer is pointer-events:none so the canvas stays
        // interactive; each element opts itself back in.
        element.style.pointerEvents = "auto";
        element.style.width = "420px";
        element.style.height = "220px";
        element.innerHTML = `<style>${CARD_CSS}</style>${cardHtml("Live DOM", "Selectable text. Real hit-testing.", args.accent)}`;

        const button = document.createElement("button");
        button.style.cssText =
          "margin-top:14px;padding:8px 16px;border-radius:999px;border:0;background:#1c1c1c;color:#fff;font:inherit;cursor:pointer";
        let clicks = 0;
        const onClick = () => {
          clicks += 1;
          button.textContent = `${args.label} · ${clicks}`;
        };
        button.addEventListener("click", onClick);
        element.querySelector(".card")?.append(button);

        const object = new CSS3DObject(element);
        // CSS3D works in pixels; the WebGL scene works in units. 0.01 puts a
        // 420px card at 4.2 units, matching the plane in HtmlTexture.
        object.scale.setScalar(0.01);
        css3dScene?.add(object);

        // A matching dark plane just behind it, so the card reads as a solid
        // object rather than floating over the clear colour.
        const shadow = new Mesh(
          new PlaneGeometry(4.4, 2.4),
          new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
        );
        shadow.position.z = -0.06;
        scene.add(shadow);
        camera.position.set(0, 0, 5);

        createEffect(() => {
          button.textContent = clicks === 0 ? args.label : `${args.label} · ${clicks}`;
        });

        onFrame(({ elapsed }) => {
          const y = Math.sin(elapsed * args.spin) * 0.5;
          object.rotation.y = y;
          shadow.rotation.y = y;
        });

        onDispose(() => button.removeEventListener("click", onClick));
      }}
    />
  ),
};
