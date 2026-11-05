/**
 * What the browser painted, read back as numbers a test can compare.
 *
 * Chromium reports a computed colour in the form it was written — `oklch(…)`
 * for cire's ramps, with an alpha where the token has one — so a string
 * comparison says nothing about contrast. Painting the layers on a 1px canvas
 * and reading the pixel back gives plain sRGB, composited the way the screen
 * shows it, which is what WCAG's ratio is defined on.
 */

/** Paint `layers` bottom-up on a 1px canvas and read back `[r, g, b]`, 0–255. */
export function composite(layers: readonly string[]): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/** What `element` is painted over: every background from the root in, its own last. */
export function backdropLayers(element: Element): string[] {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  return layers;
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast between two painted colours (1–21). */
export function ratio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `element`'s text colour against what it sits on, both composited. */
export function inkRatio(element: Element): number {
  const under = backdropLayers(element);
  const ground = composite(under);
  const ink = composite([...under, getComputedStyle(element).color]);
  return ratio(ink, ground);
}

/** Two painted colours as one comparable string, for "these are the same paint". */
export function painted(color: string): string {
  return composite([color]).join(",");
}
