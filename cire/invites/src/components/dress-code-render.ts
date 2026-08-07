/**
 * Validates a CSS color string before it is interpolated into an inline
 * `style` attribute — the render-time half of the CSS-injection gate. The
 * single source of truth lives in `@cire/theme` (IB-S-L1) and is shared with
 * the API's write-time validator, so the two sides cannot drift.
 */
export { isSafeCssColor as isValidColor } from "@cire/theme";

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
