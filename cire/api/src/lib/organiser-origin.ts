/**
 * The organiser portal's production origin: what an organiser link falls back
 * to when a tier's `WEB_ORIGIN` names no organiser origin.
 */
export const DEFAULT_ORGANISER_ORIGIN = "https://host.cireweddings.com";

/**
 * The organiser portal's origin for this tier. `WEB_ORIGIN` is a comma list —
 * guest invite, organiser portal, vendor portal — so it is the second entry,
 * trimmed, or {@link DEFAULT_ORGANISER_ORIGIN} when there is none.
 */
export function organiserOriginFrom(webOrigin: string): string {
  const entry = webOrigin.split(",").at(1)?.trim();
  return entry || DEFAULT_ORGANISER_ORIGIN;
}
