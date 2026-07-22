/**
 * Colour maths shared by every side of the invite theme boundary — the API's
 * write-time validation, the guest site's render, and the organiser's live
 * preview. It lives HERE (not in any one app) for the same reason
 * `isSafeCssColor` does: three hand-maintained copies of the same conversion
 * would drift, and a drifted derivation means the organiser's preview lies
 * about what a guest sees.
 *
 * Everything is oklch-centred. Seeds arrive in whatever allow-listed format the
 * organiser's picker emits (hex today), get converted once, and every derived
 * token is emitted as `oklch(L% C H)` / `oklch(L% C H / A)` — a format the
 * existing `isSafeCssColor` allow-list already accepts, so derived output can
 * cross the same gate as hand-picked input.
 */

/** Gamma-encoded sRGB components, each in [0, 1]. */
export type Rgb = { r: number; g: number; b: number };

/**
 * A colour in OKLCH: lightness [0, 1], chroma (typically 0–0.4), hue in degrees
 * [0, 360), and alpha [0, 1]. This is the working representation — derivation
 * moves lightness and alpha, and leaves hue alone so a derived token keeps the
 * seed's character.
 */
export interface Oklch {
  l: number;
  c: number;
  h: number;
  a: number;
}

/** Clamp into [0, 1] — oklch can name out-of-gamut colours; clip for our use. */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function parseHex(value: string): Rgb | null {
  const hex = value.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  // 3/4-digit shorthand expands per-digit; 6/8-digit reads pairs. Alpha ignored
  // (a translucent value over an unknown backdrop has no single contrast ratio,
  // and seeds are always opaque).
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b] = hex;
    return {
      r: parseInt(r + r, 16) / 255,
      g: parseInt(g + g, 16) / 255,
      b: parseInt(b + b, 16) / 255,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    };
  }
  return null;
}

/** Split a functional notation's inner arguments on commas, slashes and spaces. */
function args(value: string): string[] {
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  if (open < 0 || close <= open) return [];
  return value
    .slice(open + 1, close)
    .split(/[\s,/]+/)
    .filter((s) => s.length > 0);
}

/** A numeric component: plain number, or a percentage scaled to `pctScale`. */
function num(raw: string | undefined, pctScale: number): number | null {
  if (!raw) return null;
  const isPct = raw.endsWith("%");
  const n = Number.parseFloat(isPct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n)) return null;
  return isPct ? (n / 100) * pctScale : n;
}

function parseRgbFn(value: string): Rgb | null {
  const [r, g, b] = args(value);
  const rn = num(r, 255);
  const gn = num(g, 255);
  const bn = num(b, 255);
  if (rn === null || gn === null || bn === null) return null;
  return { r: clamp01(rn / 255), g: clamp01(gn / 255), b: clamp01(bn / 255) };
}

function parseHslFn(value: string): Rgb | null {
  const [h, s, l] = args(value);
  const hn = num(h?.replace(/deg$/i, ""), 360);
  const sn = num(s, 1);
  const ln = num(l, 1);
  if (hn === null || sn === null || ln === null) return null;
  const sat = clamp01(sn);
  const light = clamp01(ln);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = (((hn % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = light - c / 2;
  return { r: clamp01(r1 + m), g: clamp01(g1 + m), b: clamp01(b1 + m) };
}

/** Linear-light value → sRGB gamma encoding. */
function gamma(linear: number): number {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

/** sRGB gamma encoding → linear light. */
function degamma(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
}

/** OKLCH → gamma-encoded sRGB (standard Björn Ottosson matrices). */
export function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  const rLin = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return {
    r: clamp01(gamma(clamp01(rLin))),
    g: clamp01(gamma(clamp01(gLin))),
    b: clamp01(gamma(clamp01(bLin))),
  };
}

/** Gamma-encoded sRGB → OKLCH (the inverse of {@link oklchToRgb}; alpha 1). */
export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const rLin = degamma(r);
  const gLin = degamma(g);
  const bLin = degamma(b);
  const l_ = Math.cbrt(0.4122214708 * rLin + 0.5363325363 * gLin + 0.0514459929 * bLin);
  const m_ = Math.cbrt(0.2119034982 * rLin + 0.6806995451 * gLin + 0.1073969566 * bLin);
  const s_ = Math.cbrt(0.0883024619 * rLin + 0.2817188376 * gLin + 0.6299787005 * bLin);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(A * A + B * B);
  // A neutral (chroma ≈ 0) colour has no meaningful hue; pin it to 0 so the
  // output is stable rather than dependent on floating-point noise.
  const h = c < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: clamp01(L), c, h, a: 1 };
}

function parseOklchFn(value: string): Oklch | null {
  const [l, c, h, alpha] = args(value);
  const L = num(l, 1);
  const C = num(c ?? "0", 0.4);
  const H = num((h ?? "0").replace(/deg$/i, ""), 360);
  if (L === null || C === null || H === null) return null;
  const A = alpha === undefined ? 1 : num(alpha, 1);
  return { l: clamp01(L), c: Math.max(0, C), h: ((H % 360) + 360) % 360, a: clamp01(A ?? 1) };
}

/**
 * Parse a CSS colour string (the allow-listed formats) into OKLCH, or `null`
 * for anything unparseable. An `oklch(...)` input is read directly rather than
 * round-tripped through sRGB, so a colour the guest site already emits survives
 * a re-derivation unchanged (no drift from repeated gamut clipping).
 */
export function parseColor(value: string): Oklch | null {
  const v = value.trim().toLowerCase();
  if (v.startsWith("oklch(")) return parseOklchFn(v);
  const rgb = parseCssColor(v);
  return rgb ? rgbToOklch(rgb) : null;
}

/**
 * Parse a CSS colour string into gamma-encoded sRGB components in [0, 1], or
 * `null` for anything unparseable. Kept exported because the contrast helpers
 * and the organiser's advisory both work in sRGB.
 */
export function parseCssColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  if (v.startsWith("#")) return parseHex(v);
  if (v.startsWith("rgb(") || v.startsWith("rgba(")) return parseRgbFn(v);
  if (v.startsWith("hsl(") || v.startsWith("hsla(")) return parseHslFn(v);
  if (v.startsWith("oklch(")) {
    const o = parseOklchFn(v);
    return o ? oklchToRgb(o) : null;
  }
  return null;
}

/** Round to `places` decimals without trailing zeros (keeps emitted CSS tidy). */
function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Format an OKLCH colour as a CSS string. Always uses the `oklch()` function
 * with a percentage lightness, and appends `/ alpha` only when translucent —
 * both forms pass `isSafeCssColor`, so derived tokens can be re-validated by
 * the same gate that guards hand-picked ones.
 */
export function formatOklch({ l, c, h, a }: Oklch): string {
  const base = `oklch(${round(l * 100, 2)}% ${round(c, 4)} ${round(h, 2)}`;
  return a >= 1 ? `${base})` : `${base} / ${round(a, 3)})`;
}

/** WCAG relative luminance of a gamma-encoded sRGB colour. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * degamma(r) + 0.7152 * degamma(g) + 0.0722 * degamma(b);
}

/** WCAG 2.x contrast ratio between two luminances (1..21). */
function ratioOf(la: number, lb: number): number {
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG 2.x contrast ratio between two CSS colours (1..21), or `null` when
 * either colour can't be parsed. Alpha is ignored — a translucent colour over
 * an unknown backdrop has no single ratio.
 */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseCssColor(a);
  const cb = parseCssColor(b);
  if (!ca || !cb) return null;
  return ratioOf(luminance(ca), luminance(cb));
}

/** Contrast ratio between two already-parsed OKLCH colours. */
export function contrastOklch(a: Oklch, b: Oklch): number {
  return ratioOf(luminance(oklchToRgb(a)), luminance(oklchToRgb(b)));
}

/** The WCAG AA minimum for normal-size text. */
export const WCAG_TEXT_MIN = 4.5;

/** The WCAG AA minimum for large text, UI components and focus indicators. */
export const WCAG_UI_MIN = 3;

/** Move a colour's lightness by `delta`, clamped to [0, 1]. */
export function shiftLightness(color: Oklch, delta: number): Oklch {
  return { ...color, l: clamp01(color.l + delta) };
}

/** The same colour at a different alpha. */
export function withAlpha(color: Oklch, a: number): Oklch {
  return { ...color, a: clamp01(a) };
}

/**
 * Push `color`'s lightness away from `against` until the pair clears `target`
 * contrast, and return the adjusted colour. The direction is chosen once, up
 * front, by which end of the scale has more room — so light text on a dark
 * ground gets lighter, dark text on a light ground gets darker, and neither
 * ever walks past the other and inverts the design.
 *
 * This is the difference between the old builder's contrast ADVISORY (warn,
 * then ship an unreadable invite anyway) and the palette's guarantee: an
 * organiser can still pick any five colours, but the derived text tokens are
 * moved until they are legible. Returns the original colour untouched when it
 * already clears, so a well-chosen palette is never altered.
 *
 * Chroma is reduced alongside extreme lightness because a fully-saturated hue
 * cannot reach very high or very low lightness inside sRGB — holding chroma
 * would make the clip, not the nudge, decide the final colour.
 */
export function ensureContrast(color: Oklch, against: Oklch, target: number): Oklch {
  if (contrastOklch(color, against) >= target) return color;
  // Head for whichever pole is further from the backdrop — more room to move.
  const goLighter = against.l < 0.5;
  const STEP = 0.02;
  let best = color;
  for (let i = 1; i <= 50; i++) {
    const l = clamp01(color.l + (goLighter ? i * STEP : -i * STEP));
    // Ease chroma off as we approach either pole so the colour stays in gamut.
    const headroom = goLighter ? 1 - l : l;
    const candidate: Oklch = { ...color, l, c: Math.min(color.c, headroom * 0.6) };
    best = candidate;
    if (contrastOklch(candidate, against) >= target) return candidate;
    if (l === 0 || l === 1) break;
  }
  // Ran out of range (e.g. a mid-grey backdrop where nothing clears): return the
  // most-contrasting candidate we found rather than the caller's original.
  return contrastOklch(best, against) > contrastOklch(color, against) ? best : color;
}
