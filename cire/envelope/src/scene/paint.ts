/**
 * The envelope's surfaces, drawn into 2D canvases and used as textures. A 2D
 * canvas takes any CSS colour, `oklch()` included, so the liner can be drawn
 * in the invite's own palette straight from its custom properties.
 *
 * Every random-looking detail comes from a fixed seed, so the envelope looks
 * the same on every visit and in every screenshot.
 */

import { CanvasTexture, LinearFilter } from "three";

/** The envelope's paper: a warm ivory that reads as paper on a dark or a light invite. */
export const PAPER = "#f2ebdd";
/** The card's paper edge, a shade brighter than the envelope. */
export const CARD_PAPER = "#fbf8f1";

/** A seeded pseudo-random source in [0, 1). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function surface(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("envelope: no 2D context");
  return ctx;
}

function texture(ctx: CanvasRenderingContext2D): CanvasTexture {
  const tex = new CanvasTexture(ctx.canvas);
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  // No colour space: the scene runs with colour management off (`scene.ts`),
  // so the canvas's sRGB bytes reach the screen as drawn.
  return tex;
}

/** The side of the square the paper grain repeats on, in texels. */
const GRAIN_TILE = 128;
/** One speck per this many texels. */
const GRAIN_SPACING = 90;

const grainTiles = new Map<string, HTMLCanvasElement>();

/**
 * A seeded tile of single-texel specks, dark and light, each at a random
 * share of `alpha`. Written in one `ImageData` and kept, so each paper build
 * and each replay reuses it.
 */
function grainTile(seed: number, alpha: number): HTMLCanvasElement {
  const id = `${seed}:${alpha}`;
  const kept = grainTiles.get(id);
  if (kept) return kept;
  const ctx = surface(GRAIN_TILE, GRAIN_TILE);
  const image = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  const rand = seeded(seed);
  const count = Math.round((GRAIN_TILE * GRAIN_TILE) / GRAIN_SPACING);
  for (let i = 0; i < count; i++) {
    const shade = rand() < 0.5 ? 0 : 255;
    const opacity = alpha * rand();
    const at = (Math.floor(rand() * GRAIN_TILE) * GRAIN_TILE + Math.floor(rand() * GRAIN_TILE)) * 4;
    image.data[at] = shade;
    image.data[at + 1] = shade;
    image.data[at + 2] = shade;
    image.data[at + 3] = Math.round(opacity * 255);
  }
  ctx.putImageData(image, 0, 0);
  grainTiles.set(id, ctx.canvas);
  return ctx.canvas;
}

/**
 * Fine speckle over a filled area, so flat paper does not read as plastic:
 * one fill with the seeded tile as a repeating pattern, inside the current clip.
 */
function grain(ctx: CanvasRenderingContext2D, seed: number, alpha: number): void {
  const pattern = ctx.createPattern(grainTile(seed, alpha), "repeat");
  if (!pattern) return;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function polygon(ctx: CanvasRenderingContext2D, points: ReadonlyArray<readonly [number, number]>) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

/**
 * The envelope's front as the guest sees it: the side and bottom flaps folded
 * over the pocket, each a slightly different shade, with a soft shadow along
 * the bottom flap's edge. `scale` is texels per world unit.
 */
export function pocketTexture(width: number, height: number, scale: number): CanvasTexture {
  const w = width * scale;
  const h = height * scale;
  const ctx = surface(w, h);
  const wash = ctx.createLinearGradient(0, 0, 0, h);
  wash.addColorStop(0, "#f5efe3");
  wash.addColorStop(1, "#e9e0cf");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  // Side flaps, from the top corners to a point just short of the middle.
  ctx.fillStyle = "rgba(120, 96, 60, 0.07)";
  polygon(ctx, [
    [0, 0],
    [w * 0.47, h * 0.52],
    [0, h],
  ]);
  ctx.fill();
  polygon(ctx, [
    [w, 0],
    [w * 0.53, h * 0.52],
    [w, h],
  ]);
  ctx.fill();

  // The bottom flap over both, with its edge's shadow cast up onto them.
  const bottom: ReadonlyArray<readonly [number, number]> = [
    [0, h],
    [w * 0.5, h * 0.36],
    [w, h],
  ];
  ctx.save();
  ctx.shadowColor = "rgba(70, 50, 25, 0.22)";
  ctx.shadowBlur = 6 * scale;
  ctx.shadowOffsetY = -1.5 * scale;
  ctx.fillStyle = "#f4eee2";
  polygon(ctx, bottom);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = "rgba(90, 70, 40, 0.18)";
  ctx.lineWidth = Math.max(1, 0.75 * scale);
  polygon(ctx, bottom);
  ctx.stroke();

  grain(ctx, 7, 0.05);
  return texture(ctx);
}

/**
 * The top flap, a triangle on a transparent ground: `outer` is the paper side
 * the guest sees while it is sealed, the other side is the liner, drawn in the
 * invite's raised surface colour with a fine diagonal hatch in its gold.
 */
export function flapTexture(
  width: number,
  depth: number,
  scale: number,
  side: "outer" | { ground: string; ink: string },
): CanvasTexture {
  const w = width * scale;
  const h = depth * scale;
  const ctx = surface(w, h);
  const tri: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [w, 0],
    [w / 2, h],
  ];
  if (side === "outer") {
    ctx.save();
    ctx.shadowColor = "rgba(60, 40, 20, 0.28)";
    ctx.shadowBlur = 8 * scale;
    ctx.shadowOffsetY = 2 * scale;
    const wash = ctx.createLinearGradient(0, 0, 0, h);
    wash.addColorStop(0, "#f7f2e8");
    wash.addColorStop(1, "#ece3d2");
    ctx.fillStyle = wash;
    polygon(ctx, tri);
    ctx.fill();
    ctx.restore();
    ctx.save();
    polygon(ctx, tri);
    ctx.clip();
    grain(ctx, 11, 0.05);
    ctx.restore();
  } else {
    ctx.save();
    polygon(ctx, tri);
    ctx.clip();
    ctx.fillStyle = side.ground;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = side.ink;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(1, 0.6 * scale);
    const step = 7 * scale;
    for (let x = -h; x < w + h; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + h, h);
      ctx.stroke();
    }
    ctx.restore();
  }
  return texture(ctx);
}

/** A soft elliptical shadow, black fading to clear. */
export function shadowTexture(): CanvasTexture {
  const size = 128;
  const ctx = surface(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(0,0,0,0.42)");
  g.addColorStop(0.55, "rgba(0,0,0,0.2)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return texture(ctx);
}

/** The seal face's colour map and bump map. */
export interface SealFace {
  readonly map: CanvasTexture;
  readonly bump: CanvasTexture;
}

/**
 * The seal's face, as a colour map and a bump map from one drawing: the wax
 * a little paler at its centre, a pressed ring, and the die's letter raised in
 * the middle. The placeholder die is a "C" in the invite's display face.
 */

export function sealFaceTextures(wax: string, letter: string, font: string): SealFace {
  const size = 512;
  const c = size / 2;
  const draw = (mode: "colour" | "bump") => {
    const ctx = surface(size, size);
    if (mode === "colour") {
      ctx.fillStyle = wax;
      ctx.fillRect(0, 0, size, size);
      const glow = ctx.createRadialGradient(c * 0.8, c * 0.75, 0, c, c, c);
      glow.addColorStop(0, "rgba(255,255,255,0.16)");
      glow.addColorStop(1, "rgba(0,0,0,0.18)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);
    } else {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, size, size);
    }
    ctx.filter = mode === "bump" ? "blur(5px)" : "blur(1px)";
    ctx.lineWidth = size * 0.035;
    ctx.strokeStyle = mode === "bump" ? "#3a3a3a" : "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.arc(c, c, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = mode === "bump" ? "#e8e8e8" : "rgba(255,235,225,0.22)";
    ctx.font = `600 ${Math.round(size * 0.46)}px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, c, c + size * 0.02);
    return texture(ctx);
  };
  return { map: draw("colour"), bump: draw("bump") };
}
