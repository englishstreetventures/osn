/**
 * Pricing regions — the closed set of `weddings.pricing_region` values and the
 * checked-in mapping from a geocoded (state, country) onto one.
 *
 * Single source of truth for everything region-shaped: the Settings save
 * validates organiser-supplied values against {@link PRICING_REGIONS}, the
 * geocode flow derives a region via {@link derivePricingRegion}, and the
 * Phase 3 pricing engine keys its baseline dataset (`lib/pricing-baselines.ts`)
 * off the same union — mirroring the pulse `shareSource` single-source pattern.
 *
 * AU-first, state-granular. State level is deliberately coarse for v1: the
 * baseline dataset is hand-curated (see platform-plan §6) and a per-state range
 * is defensible where a per-suburb one would be invented. `au-other` covers an
 * AU geocode without a recognisable state; `international` everything else.
 * Widening (e.g. metro/regional splits) means appending literals here and rows
 * to the dataset — both reviewed together.
 *
 * The mapping is content, not code — bump {@link PRICING_REGIONS_VERSION} on
 * any change so estimate metrics/provenance can pin which mapping produced them.
 */

export const PRICING_REGIONS_VERSION = 1;

export const PRICING_REGIONS = [
  "au-nsw",
  "au-vic",
  "au-qld",
  "au-wa",
  "au-sa",
  "au-tas",
  "au-act",
  "au-nt",
  "au-other",
  "international",
] as const;

export type PricingRegion = (typeof PRICING_REGIONS)[number];

const REGION_SET = new Set<string>(PRICING_REGIONS);

export function isPricingRegion(value: string): value is PricingRegion {
  return REGION_SET.has(value);
}

/** Geocoded AU state/territory (short administrative-area code) → region. */
const AU_STATE_REGIONS: Record<string, PricingRegion> = {
  NSW: "au-nsw",
  VIC: "au-vic",
  QLD: "au-qld",
  WA: "au-wa",
  SA: "au-sa",
  TAS: "au-tas",
  ACT: "au-act",
  NT: "au-nt",
};

/**
 * Derive the pricing region from a geocode result's country + administrative
 * area. Total: any AU address without a recognisable state maps to `au-other`,
 * any non-AU (or unknown) country to `international` — never null, so a
 * successful geocode always yields a usable region key.
 *
 * @param countryCode ISO 3166-1 alpha-2 short code from the geocoder (e.g. "AU")
 * @param adminArea   administrative_area_level_1 SHORT name (e.g. "NSW")
 */
export function derivePricingRegion(
  countryCode: string | null,
  adminArea: string | null,
): PricingRegion {
  if ((countryCode ?? "").toUpperCase() !== "AU") return "international";
  const region = AU_STATE_REGIONS[(adminArea ?? "").toUpperCase()];
  return region ?? "au-other";
}
