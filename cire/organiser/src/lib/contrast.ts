/**
 * WCAG 2.x contrast helper for the invite builder's live colour advisory
 * (WT-C-L1). Parses the colour formats the theme allow-list accepts — hex,
 * rgb(a), hsl(a), oklch — into sRGB, and computes the WCAG contrast ratio.
 * Anything unparseable returns `null` so the advisory simply stays silent
 * (it is a warning, never a gate; the server-side allow-list remains the only
 * validator).
 */

type Rgb = { r: number; g: number; b: number };

/** Clamp into [0, 1] — oklch can name out-of-gamut colours; clip for advisory use. */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function parseHex(value: string): Rgb | null {
  const hex = value.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  // 3/4-digit shorthand expands per-digit; 6/8-digit reads pairs. Alpha ignored
  // (advisory treats colours as opaque — a translucent value over an unknown
  // backdrop has no single contrast ratio).
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

function parseOklchFn(value: string): Rgb | null {
  const [l, c, h] = args(value);
  const L = num(l, 1);
  const C = h === undefined && c === undefined ? null : num(c ?? "0", 0.4);
  const H = num((h ?? "0").replace(/deg$/i, ""), 360);
  if (L === null || C === null || H === null) return null;
  // oklch → oklab → LMS → linear sRGB (standard Björn Ottosson matrices).
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
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

/**
 * Parse a CSS colour string (the allow-listed formats) into gamma-encoded sRGB
 * components in [0, 1], or `null` for anything unparseable.
 */
export function parseCssColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  if (v.startsWith("#")) return parseHex(v);
  if (v.startsWith("rgb(") || v.startsWith("rgba(")) return parseRgbFn(v);
  if (v.startsWith("hsl(") || v.startsWith("hsla(")) return parseHslFn(v);
  if (v.startsWith("oklch(")) return parseOklchFn(v);
  return null;
}

/** WCAG relative luminance of a gamma-encoded sRGB colour. */
function luminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG 2.x contrast ratio between two CSS colours (1..21), or `null` when
 * either colour can't be parsed.
 */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseCssColor(a);
  const cb = parseCssColor(b);
  if (!ca || !cb) return null;
  const la = luminance(ca);
  const lb = luminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The WCAG AA minimum for normal-size text — the advisory's warn threshold. */
export const WCAG_TEXT_MIN = 4.5;
