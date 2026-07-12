/**
 * Key-optional server-side geocoding for the wedding Settings form (platform
 * Phase 0, PR 1). Mirrors the project's other key-optional integrations
 * (Turnstile, the Maps Embed key, `OSN_EMAIL_OPTIONAL`):
 *
 *  - **Key UNSET** → `createGoogleGeocoder(undefined)` returns `null`. The
 *    geocode route answers `{ status: "unavailable" }` and the Settings form
 *    falls back to manual lat/lng entry — the profile still works end-to-end
 *    with no third-party flow at all (the compliance-relevant property: the
 *    degraded mode sends nothing to Google).
 *  - **Key SET** → the organiser-typed address is sent to Google's Geocoding
 *    API and the first result's point + locality/state/country come back.
 *    FAIL-SOFT: a network error, timeout, non-2xx, or malformed body resolves
 *    to `{ status: "unavailable" }` (never throws, never 500s) — the form
 *    degrades to manual entry exactly as if no key were set.
 *
 * The key is never logged and never sent anywhere except Google's endpoint.
 * Only the organiser-typed address string leaves the Worker — never guest data.
 */

import { instrumentedFetch } from "@shared/observability/fetch";

/** Google's Geocoding API endpoint (JSON output). */
export const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

/** Minimal fetch shape — injectable for unit tests (same idiom as
 *  `@shared/turnstile`'s `FetchLike`). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GeocodePoint {
  lat: number;
  lng: number;
  /** Locality (suburb/town) long name, when Google returned one. */
  locality: string | null;
  /** administrative_area_level_1 SHORT name (e.g. "NSW"), when returned. */
  adminArea: string | null;
  /** ISO 3166-1 alpha-2 country short code (e.g. "AU"), when returned. */
  countryCode: string | null;
  /** Google's canonical formatted address — echoed to the form so the
   *  organiser can confirm the right place was matched. */
  formattedAddress: string;
}

export type GeocodeOutcome =
  | { status: "ok"; point: GeocodePoint }
  /** The service worked but the query matched nothing. */
  | { status: "not_found" }
  /** No key configured, or the upstream call failed — fall back to manual. */
  | { status: "unavailable" };

export interface Geocoder {
  geocode(query: string): Promise<GeocodeOutcome>;
}

/** Shape of Google's Geocoding JSON response (subset we read). */
interface GeocodeResponse {
  status?: string;
  results?: Array<{
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: Array<{
      long_name?: string;
      short_name?: string;
      types?: string[];
    }>;
  }>;
}

function component(
  components: NonNullable<GeocodeResponse["results"]>[number]["address_components"],
  type: string,
  field: "long_name" | "short_name",
): string | null {
  const match = components?.find((c) => c.types?.includes(type));
  const value = match?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Build a geocoder from the (optional) API key. `undefined`/empty key ⇒ `null`
 * — the caller treats a null geocoder as "geocoding not configured".
 *
 * `fetchImpl` is injectable purely for unit tests — production always uses the
 * instrumented fetch so the upstream call shows up on the trace tree (the key
 * is in the query string but spans record only method + host, never the URL
 * query — see `@shared/observability/fetch`).
 */
export function createGoogleGeocoder(
  apiKey: string | undefined,
  fetchImpl: FetchLike = instrumentedFetch,
): Geocoder | null {
  if (!apiKey) return null;

  return {
    async geocode(query: string): Promise<GeocodeOutcome> {
      const url = new URL(GEOCODE_URL);
      url.searchParams.set("address", query);
      url.searchParams.set("key", apiKey);

      try {
        const res = await fetchImpl(url, {
          // Bound the call so a hung upstream can't tie up the isolate; an
          // abort lands in the catch → fail-soft `unavailable`.
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return { status: "unavailable" };

        const data = (await res.json()) as GeocodeResponse;
        // ZERO_RESULTS is a real verdict ("no such place"); every other
        // non-OK status (OVER_QUERY_LIMIT, REQUEST_DENIED, …) is an
        // infrastructure/config failure → degrade to manual entry.
        if (data.status === "ZERO_RESULTS") return { status: "not_found" };
        if (data.status !== "OK") return { status: "unavailable" };

        const first = data.results?.[0];
        const lat = first?.geometry?.location?.lat;
        const lng = first?.geometry?.location?.lng;
        if (typeof lat !== "number" || typeof lng !== "number") {
          return { status: "unavailable" };
        }

        return {
          status: "ok",
          point: {
            lat,
            lng,
            locality: component(first?.address_components, "locality", "long_name"),
            adminArea: component(
              first?.address_components,
              "administrative_area_level_1",
              "short_name",
            ),
            countryCode: component(first?.address_components, "country", "short_name"),
            formattedAddress: first?.formatted_address ?? query,
          },
        };
      } catch {
        // Network error, abort, malformed JSON — fail soft. The thrown value
        // is deliberately not logged here (the request URL embeds the key);
        // the route logs the boolean outcome.
        return { status: "unavailable" };
      }
    },
  };
}
