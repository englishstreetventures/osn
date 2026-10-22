/**
 * Mobile-Safari edge colours for the invite (issue #1700).
 *
 * The status bar and the bottom toolbar of iOS Safari take their colour from
 * what is painted behind them, so the top and bottom edges of the viewport get
 * fixed strips coloured to match the page. The strips only exist on a device
 * that reports a safe-area inset (a notch, a home indicator); everywhere else
 * `env(safe-area-inset-*)` is 0 and nothing is drawn.
 *
 * Three layers share one set of rules here:
 * - `EDGE_BOOT_SCRIPT`: a tiny inline script rendered into `<head>` so the
 *   classes are set before first paint. It is built from the same class names
 *   and the same parse rule as the functions below, and a unit test runs it.
 * - the pure functions (`parseInsetPx`, `decideEdges`, `bottomIsHero`,
 *   `edgeStyle`, `oklchToHex`): the decisions, each unit-tested.
 * - `startEdgeColours`: the client loop that keeps the colours current.
 */
import { parseCssColor } from "@cire/theme";

/** Class on `<html>` when the top inset is non-zero. Set by the boot script and the loop. */
export const EDGE_TOP_CLASS = "has-safe-top";
/** Class on `<html>` when the bottom inset is non-zero. */
export const EDGE_BOTTOM_CLASS = "has-safe-bottom";
/** Class on each strip element. */
export const EDGE_STRIP_CLASS = "edge-strip";
/** Smallest strip height. Safari needs at least 5px visible to sample the colour. */
export const EDGE_MIN_PX = 12;
/** Attribute on the hero root element. The loop reads its position. */
export const EDGE_HERO_ATTR = "data-edge-hero";
/** Used when a colour cannot be read or is not a hex value. */
const FALLBACK_HEX = "#000000";

/**
 * A CSS length in px from a computed `padding-*`. Anything that is not a
 * positive number (empty, `NaN`, `auto`, a non-px unit read as a number) is 0,
 * so an unsupported browser simply gets no strips.
 */
export function parseInsetPx(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Which edges get a strip. */
export interface EdgeFlags {
  top: boolean;
  bottom: boolean;
}

/** Each edge is on when its own inset is non-zero. */
export function decideEdges(topPx: number, bottomPx: number): EdgeFlags {
  return { top: topPx > 0, bottom: bottomPx > 0 };
}

/**
 * Whether the hero still covers the bottom strip zone, so the strip should take
 * the hero's end colour. The zone is the bottom `stripHeight` px of the
 * viewport, which is `[innerHeight - stripHeight, innerHeight]`. The hero's
 * bottom edge sits above `innerHeight` by the scroll distance, so it covers the
 * zone while its bottom is still below the zone's top edge.
 */
export function bottomIsHero(
  heroBottom: number,
  innerHeight: number,
  stripHeight: number,
): boolean {
  return heroBottom > innerHeight - stripHeight;
}

const HEX = /^#[0-9a-f]{6}$/;

/**
 * The inline `style` declarations for the edge colours, for `<html>`. Each
 * value must be a six-digit hex; anything else falls back to a constant, so no
 * server-side input can break out of the declaration.
 */
export function edgeStyle(colours: { top: string; bottom: string }): string {
  const top = HEX.test(colours.top) ? colours.top : FALLBACK_HEX;
  const bottom = HEX.test(colours.bottom) ? colours.bottom : FALLBACK_HEX;
  return `--edge-top-bg:${top};--edge-bottom-bg:${bottom}`;
}

/**
 * The first-paint colours, from the palette the server renders. The top edge is
 * the hero's start colour when a hero is shown, the page colour otherwise. The
 * bottom edge is the hero's end colour when a hero is shown: at scroll 0 the
 * hero covers the bottom strip zone. The client loop corrects both on scroll.
 */
export function serverEdgeColours(
  palette: Record<string, string>,
  heroShown: boolean,
): { top: string; bottom: string } {
  const page = oklchToHex(palette["--color-bg"] ?? "") ?? FALLBACK_HEX;
  const heroTop = oklchToHex(palette["--invite-hero-grad-1"] ?? "") ?? page;
  const heroEnd = oklchToHex(palette["--invite-hero-grad-3"] ?? "") ?? page;
  return heroShown ? { top: heroTop, bottom: heroEnd } : { top: page, bottom: page };
}

/** An OKLCH or other CSS colour string as `#rrggbb`, or `null` if it does not parse. */
export function oklchToHex(value: string): string | null {
  const rgb = parseCssColor(value.trim());
  if (!rgb) return null;
  const channel = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(channel(rgb.r))}${hex(channel(rgb.g))}${hex(channel(rgb.b))}`;
}

/**
 * The inline boot script for `<head>`. It measures the insets with a probe
 * element that carries its own inline style, so it does not depend on
 * `global.css` having loaded. The rule is the same as `parseInsetPx` and
 * `decideEdges` above; `edge-boot.test.ts` runs this string against both.
 */
export const EDGE_BOOT_SCRIPT = `(function () {
  var root = document.documentElement;
  var probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
  root.appendChild(probe);
  var cs = getComputedStyle(probe);
  var top = parseFloat(cs.paddingTop);
  var bottom = parseFloat(cs.paddingBottom);
  probe.parentNode.removeChild(probe);
  top = Number.isFinite(top) && top > 0 ? top : 0;
  bottom = Number.isFinite(bottom) && bottom > 0 ? bottom : 0;
  root.classList.toggle("${EDGE_TOP_CLASS}", top > 0);
  root.classList.toggle("${EDGE_BOTTOM_CLASS}", bottom > 0);
})();`;

/** A pair of insets in px. */
export interface Insets {
  top: number;
  bottom: number;
}

/** Read both insets in px from a probe element, using the same rule as the boot script. */
function readInsets(doc: Document): Insets {
  const win = doc.defaultView;
  if (!win) return { top: 0, bottom: 0 };
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
  doc.documentElement.appendChild(probe);
  const cs = win.getComputedStyle(probe);
  const top = parseInsetPx(cs.paddingTop);
  const bottom = parseInsetPx(cs.paddingBottom);
  probe.remove();
  return { top, bottom };
}

/**
 * Keep the edge strips and the theme colour current. Returns a cleanup that
 * removes every listener. Idempotent with the boot script: it sets the same
 * classes from the same rule, so a late run changes nothing it has not already
 * set. Called once from the invite shell's module script.
 */
export function startEdgeColours(
  doc: Document = document,
  readInsetsFrom: (d: Document) => Insets = readInsets,
): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const root = doc.documentElement;
  let frame = 0;

  const apply = () => {
    frame = 0;
    const insets = readInsetsFrom(doc);
    const edges = decideEdges(insets.top, insets.bottom);
    root.classList.toggle(EDGE_TOP_CLASS, edges.top);
    root.classList.toggle(EDGE_BOTTOM_CLASS, edges.bottom);

    const cs = win.getComputedStyle(root);
    const pageHex = oklchToHex(cs.getPropertyValue("--color-bg")) ?? FALLBACK_HEX;
    const heroTop = oklchToHex(cs.getPropertyValue("--invite-hero-grad-1")) ?? pageHex;
    const heroEnd = oklchToHex(cs.getPropertyValue("--invite-hero-grad-3")) ?? pageHex;

    const hero = doc.querySelector<HTMLElement>(`[${EDGE_HERO_ATTR}]`);
    const top = hero ? heroTop : pageHex;
    const stripHeight = edges.bottom ? Math.max(EDGE_MIN_PX, insets.bottom) : 0;
    const bottom =
      hero &&
      stripHeight > 0 &&
      bottomIsHero(hero.getBoundingClientRect().bottom, win.innerHeight, stripHeight)
        ? heroEnd
        : pageHex;

    root.style.setProperty("--edge-top-bg", top);
    root.style.setProperty("--edge-bottom-bg", bottom);
    root.style.background = top;

    let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = doc.createElement("meta");
      meta.name = "theme-color";
      doc.head.appendChild(meta);
    }
    meta.content = top;
  };

  const schedule = () => {
    if (frame === 0) frame = win.requestAnimationFrame(apply);
  };

  const events = ["scroll", "resize", "orientationchange", "pageshow"] as const;
  for (const name of events) win.addEventListener(name, schedule, { passive: true });
  const vv = win.visualViewport;
  vv?.addEventListener("resize", schedule);
  doc.addEventListener("cire:palette", schedule);
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", schedule);
  apply();

  return () => {
    for (const name of events) win.removeEventListener(name, schedule);
    vv?.removeEventListener("resize", schedule);
    doc.removeEventListener("cire:palette", schedule);
    doc.removeEventListener("DOMContentLoaded", schedule);
    if (frame !== 0) win.cancelAnimationFrame(frame);
    frame = 0;
  };
}
