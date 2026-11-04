import { contrastRatio } from "@cire/theme";

/** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
export function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The contrast of `el`'s words against what is painted under them: the page,
 * then every ancestor's background down to `el`'s own, translucent ones
 * included.
 */
export function wordsRatio(el: Element): number {
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  const page = getComputedStyle(document.documentElement).getPropertyValue("--color-bg");
  const under = composite([page, ...layers]);
  return contrastRatio(composite([under, getComputedStyle(el).color]), under)!;
}
