/**
 * Validates a CSS color string before it is interpolated into an inline
 * `style` attribute. Strict allow-list of well-known colour function forms
 * — no named colours, no `url(...)`, no `expression(...)`, no `var(--…)`,
 * nothing that could let a malicious palette payload smuggle script-like
 * CSS through inline styles.
 *
 * Accepted forms:
 *   - hex:    `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`
 *   - rgb:    `rgb(...)`, `rgba(...)`
 *   - hsl:    `hsl(...)`, `hsla(...)`
 *   - oklch:  `oklch(...)`
 */
// Inner-paren content is restricted to digits / inline whitespace (space +
// tab — not newlines) / common CSS numeric punctuation (`%` `.` `,` `/` `-`
// `+`) plus letters that legitimate values use (`e` for exponents, `n` for
// `none`, `d` for `deg`, etc.). Excluding newlines keeps the surface narrow
// without breaking realistic palette payloads. Fails-closed on weird inputs
// even though SolidJS object-form `style` uses `setProperty` (no string-
// concat breakout possible) — defence in depth.
const INNER = "[\\d \\t,.%/+\\-a-zA-Z]*";

const COLOR_PATTERNS = [
  /^#[0-9a-fA-F]{3,8}$/,
  new RegExp(`^rgb\\(${INNER}\\)$`),
  new RegExp(`^rgba\\(${INNER}\\)$`),
  new RegExp(`^hsl\\(${INNER}\\)$`),
  new RegExp(`^hsla\\(${INNER}\\)$`),
  new RegExp(`^oklch\\(${INNER}\\)$`),
];

export function isValidColor(color: string): boolean {
  if (typeof color !== "string") return false;
  const trimmed = color.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  return COLOR_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// Cap server-supplied swatch names before they hit the DOM. Not a security
// concern (JSX escapes attribute interpolation) but a 200KB name DoSes
// layout / accessibility tree. 40 chars covers any realistic palette label
// ("Champagne Gold", "Marigold Saffron", "Forest Eucalyptus") with room.
const MAX_NAME_LENGTH = 40;

export function truncateSwatchName(name: string): string {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_NAME_LENGTH - 1)}…`;
}
