/**
 * Reads what the browser actually painted, so a story can put a measured
 * value beside a token instead of the value the stylesheet claims.
 *
 * The distinction is the point of these stories. `tokens.css` says
 * `ink-tertiary` clears 3:1 and the conformance harness checks that against
 * the stylesheet; neither can see a value an app set at runtime, a subtree
 * that redefined a token, or the theme the toggle is currently on. Reading the
 * element's computed style can, and it stays true when an app's mapping
 * changes without anyone editing the story.
 *
 * Headless, none of this measures anything: happy-dom returns an empty or
 * unresolved string, which parses to `null`, which every caller renders as
 * "unmeasured". The stories must still mount there — that is the smoke test.
 */

import { contrastOklch, type Oklch, oklchToRgb, parseColor } from "@shared/color";
import { createSignal } from "solid-js";

const [version, setVersion] = createSignal(0);
let observer: MutationObserver | undefined;

/**
 * Bumps when `<html>`'s `class` or `data-theme` changes — the lab's light ·
 * dark toggle, or an app-style attribute flip. Read it inside the effect that
 * measures, so the measurement re-runs after the flip.
 *
 * An observer rather than the lab's `theme()` signal: `setTheme` writes the
 * signal *before* it toggles the class, so an effect on the signal would read
 * the previous theme's paint. The observer fires after the DOM has changed.
 */
export function themeVersion(): number {
  if (
    observer === undefined &&
    typeof MutationObserver !== "undefined" &&
    typeof document !== "undefined"
  ) {
    observer = new MutationObserver(() => setVersion((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
  }
  return version();
}

/** The computed value of one property on one element, or `""` where nothing can be computed. */
export function computed(el: Element | undefined, property: string): string {
  if (!el || typeof getComputedStyle !== "function") return "";
  try {
    return getComputedStyle(el).getPropertyValue(property).trim();
  } catch {
    return "";
  }
}

/**
 * A computed colour string, parsed.
 *
 * `parseColor` keeps the alpha of an `oklch()` but `parseCssColor` reads only
 * three arguments of an `rgb()`/`rgba()`, so a translucent hex-declared token
 * would come back opaque. Chrome serialises those as `rgba(r, g, b, a)`; the
 * fourth argument is read here before the result is trusted.
 */
export function parsePainted(raw: string): Oklch | null {
  const value = raw.trim();
  if (value === "") return null;
  const color = parseColor(value);
  if (!color) return null;
  const fn = /^rgba?\((.*)\)$/i.exec(value);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter((s) => s.length > 0);
    if (parts.length === 4) {
      const last = parts[3];
      const alpha = last.endsWith("%") ? Number.parseFloat(last) / 100 : Number.parseFloat(last);
      if (Number.isFinite(alpha)) return { ...color, a: Math.min(1, Math.max(0, alpha)) };
    }
  }
  return color;
}

export function paintedColor(el: Element | undefined, property: string): Oklch | null {
  return parsePainted(computed(el, property));
}

function hex2(v: number): string {
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, "0");
}

/** `#18181b`, or `#18181b · α 0.58` for a translucent colour, or `unmeasured`. */
export function describe(color: Oklch | null): string {
  if (!color) return "unmeasured";
  const { r, g, b } = oklchToRgb(color);
  const hex = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  const alpha = color.a ?? 1;
  return alpha < 1 ? `${hex} · α ${alpha.toFixed(2)}` : hex;
}

/**
 * Composite a translucent colour over an opaque ground, in sRGB — the space a
 * browser does it in. The same arithmetic the conformance harness uses.
 */
function over(fg: Oklch, bg: Oklch): Oklch {
  const f = oklchToRgb(fg);
  const b = oklchToRgb(bg);
  const a = fg.a ?? 1;
  const mixed = {
    r: a * f.r + (1 - a) * b.r,
    g: a * f.g + (1 - a) * b.g,
    b: a * f.b + (1 - a) * b.b,
  };
  // Back through the parser so the result carries `a: 1` like any opaque colour.
  return parseColor(`#${hex2(mixed.r)}${hex2(mixed.g)}${hex2(mixed.b)}`) ?? bg;
}

export interface Contrast {
  ratio: number;
  /** True when the foreground was translucent and was composited over the ground first. */
  composited: boolean;
}

/**
 * WCAG contrast of `fg` painted on `bg`, or `null` when `bg` is itself
 * translucent — what sits behind a translucent ground is not knowable from the
 * two colours, so no number is honest.
 */
export function contrastOf(fg: Oklch, bg: Oklch): Contrast | null {
  if ((bg.a ?? 1) < 1) return null;
  const translucent = (fg.a ?? 1) < 1;
  const top = translucent ? over(fg, bg) : fg;
  return { ratio: contrastOklch(top, bg), composited: translucent };
}
