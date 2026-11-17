/**
 * Where a drawn radio's dot and circle are painted, read from the pixels. A
 * twin of `shared/ui/tests/test-support/painted.ts`, as the browser commands
 * are: a test helper is not a package's export.
 *
 * A layout box says where an element should be; what a reader sees is that box
 * snapped to device pixels, and anti-aliased at its edges. So the dot is
 * measured from two pictures of the same circle at the same place, taken by
 * the `paintedBox` command at a given device pixel ratio: one unchosen, one
 * chosen. With the circle's resting edge set to the chosen edge's colour, the
 * two differ only by the dot. The circle's centre is the ink-weighted centroid
 * of the unchosen picture (a ring, the same all round), and the dot's is the
 * centroid of the difference. Both come back in CSS pixels, from the picture's
 * own corner, so the offset between them is exact whatever the clip's origin.
 */

import { commands, page } from "vitest/browser";

export type Picture = { data: Uint8ClampedArray; width: number; height: number; scale: number };

const typed = commands as unknown as {
  paintedBox: (o: { selector: string; scale: 1 | 2; pad?: number }) => Promise<{ png: string }>;
};

/** What the page paints over `element`, `pad` CSS pixels out, at `scale`. */
export async function picture(element: Element, scale: 1 | 2, pad = 4): Promise<Picture> {
  const { png } = await typed.paintedBox({
    selector: page.elementLocator(element).selector,
    scale,
    pad,
  });
  const image = new Image();
  image.src = `data:image/png;base64,${png}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height, scale };
}

/** 0 for the ground (the picture's corner pixel), up to 1 for full ink. */
function inkOf(shot: Picture): Float64Array {
  const { data } = shot;
  const [r0, g0, b0] = [data[0]!, data[1]!, data[2]!];
  const ink = new Float64Array(shot.width * shot.height);
  let most = 0;
  for (let i = 0; i < ink.length; i++) {
    const d = Math.hypot(data[i * 4]! - r0, data[i * 4 + 1]! - g0, data[i * 4 + 2]! - b0);
    ink[i] = d;
    most = Math.max(most, d);
  }
  return most === 0 ? ink : ink.map((d) => d / most);
}

/** The weighted centre of `weights`, in CSS pixels from the picture's corner. */
function centroid(weights: Float64Array, width: number, scale: number) {
  let sum = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (w <= 0) continue;
    sum += w;
    x += w * ((i % width) + 0.5);
    y += w * (Math.floor(i / width) + 0.5);
  }
  if (sum === 0) throw new Error("nothing painted");
  return { x: x / sum / scale, y: y / sum / scale };
}

/**
 * The dot's centre less the circle's, in CSS pixels, from a picture of the
 * circle unchosen and one chosen.
 */
export function dotOffset(unchosen: Picture, chosen: Picture) {
  if (unchosen.width !== chosen.width || unchosen.height !== chosen.height) {
    throw new Error("the two pictures differ in size: the circle moved");
  }
  const ring = inkOf(unchosen);
  const both = inkOf(chosen);
  const dot = both.map((v, i) => Math.max(0, v - ring[i]!));
  const circle = centroid(ring, unchosen.width, unchosen.scale);
  const centre = centroid(dot, chosen.width, chosen.scale);
  return { dx: centre.x - circle.x, dy: centre.y - circle.y };
}
