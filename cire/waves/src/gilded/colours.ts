/**
 * The Gilded wave's colours, read from the page each time a wave starts, so a
 * theme change between two waves is followed.
 *
 * The band mixes five colours in OKLab: the couple's gold, a champagne, an
 * antique gold, a blush and an ivory — the owner-approved prototype's, the same
 * in both themes, since the band is light laid over either ground. The dust
 * takes the theme's own `--gold` and `--gold-hi`, and the rim reads how light
 * the ground under it is, to turn to antique gold on a light one.
 */

import { parseCssColor, rgbToOklch, type Rgb } from "@shared/color";

import type { Colours } from "./overlay";

const BAND: readonly Rgb[] = [
  { r: 0.93, g: 0.76, b: 0.42 },
  { r: 0.98, g: 0.9, b: 0.7 },
  { r: 0.62, g: 0.44, b: 0.2 },
  { r: 0.92, g: 0.66, b: 0.58 },
  { r: 1.0, g: 0.95, b: 0.84 },
];

/** An sRGB colour as OKLab's L, a, b. */
function oklab(rgb: Rgb): [number, number, number] {
  const { l, c, h } = rgbToOklch(rgb);
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}

const PALETTE = BAND.flatMap(oklab);

/** The dark theme's gold and its highlight, for a page that sets neither token. */
const GOLD: Rgb = { r: 0.82, g: 0.7, b: 0.47 };
const GOLD_HI: Rgb = { r: 0.9, g: 0.79, b: 0.56 };

const triple = (c: Rgb): [number, number, number] => [c.r, c.g, c.b];

/** Gamma-space luma, the scale the rim's light-ground threshold was tuned on. */
const luma = (c: Rgb) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

function token(style: CSSStyleDeclaration, name: string, fallback: Rgb): Rgb {
  return parseCssColor(style.getPropertyValue(name).trim()) ?? fallback;
}

/** The colour an element paints behind its content, or `fallback` for none. */
function ground(el: Element, fallback: Rgb): Rgb {
  const value = getComputedStyle(el).backgroundColor;
  if (!value || value === "transparent" || /\/\s*0\)$|,\s*0\)$/.test(value)) return fallback;
  return parseCssColor(value) ?? fallback;
}

/**
 * The colours for a wave over `frame`. `revealing` is the direction: the frame
 * arriving over the page, or leaving it.
 */
export function readColours(frame: Element, revealing: boolean): Colours {
  const style = getComputedStyle(frame);
  const page = ground(document.body, ground(document.documentElement, { r: 1, g: 1, b: 1 }));
  const over = ground(frame, page);
  const [lumA, lumB] = revealing ? [luma(page), luma(over)] : [luma(over), luma(page)];
  return {
    palette: PALETTE,
    gold: triple(token(style, "--gold", GOLD)),
    hi: triple(token(style, "--gold-hi", GOLD_HI)),
    barLum: luma(page),
    lumA,
    lumB,
  };
}
