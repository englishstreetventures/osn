/**
 * Single source of truth for the CSS-colour allow-list (IB-S-L1).
 *
 * An organiser's colour string is interpolated into guest-facing inline
 * `style` attributes, so it must NEVER be persisted or rendered unvalidated
 * (CSS-injection risk). Both sides of that boundary import THIS module:
 *
 *   - `@cire/api` (`schemas/invite.ts`) rejects un-listed values at write
 *     time with a 400, and
 *   - `@cire/web` (`dress-code-render.ts`, `invite-theme.ts`) re-checks at
 *     render time as defence in depth.
 *
 * Keeping one copy is the point — a drifted validator on either side would
 * let an un-validated value reach rendered CSS.
 *
 * Accepted forms (no named colours, no `var(--…)`, no `url(...)`, no
 * `expression(...)`):
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
// even where the consumer is already breakout-safe (SolidJS object-form
// `style` uses `setProperty`) — defence in depth.
const COLOR_INNER = "[\\d \\t,.%/+\\-a-zA-Z]*";

const COLOR_PATTERNS = [
  /^#[0-9a-fA-F]{3,8}$/,
  new RegExp(`^rgb\\(${COLOR_INNER}\\)$`),
  new RegExp(`^rgba\\(${COLOR_INNER}\\)$`),
  new RegExp(`^hsl\\(${COLOR_INNER}\\)$`),
  new RegExp(`^hsla\\(${COLOR_INNER}\\)$`),
  new RegExp(`^oklch\\(${COLOR_INNER}\\)$`),
];

export * from "./color";
export * from "./palette";

export function isSafeCssColor(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  return COLOR_PATTERNS.some((pattern) => pattern.test(trimmed));
}
