/**
 * What "Open in maps" offers for a venue: the guest's own map app rather than
 * Google's alone.
 *
 * A module of its own so that only the event sheet loads it: `MapPreview` is
 * its one importer, and the sheet is fetched when a guest first opens one.
 * `event-details.ts`, which every invite page loads up front, keeps what the
 * page needs before then — whether there is anywhere to go at all
 * (`resolveMapsUrl`) and the one parse of the organiser's link both share.
 */
import { GOOGLE_MAPS_SEARCH, organiserMapsUrl, venueQuery } from "./event-details";
import type { EventSummary } from "./types";

/** The map apps "Open in maps" offers, in the order it offers them. */
const MAPS_PROVIDERS = ["google", "apple", "waze"] as const;
type MapsProvider = (typeof MAPS_PROVIDERS)[number];

const PROVIDER_LABEL = {
  google: "Google Maps",
  apple: "Apple Maps",
  waze: "Waze",
} as const satisfies Record<MapsProvider, string>;

/**
 * Each app's search, given a query already `encodeURIComponent`-escaped — so it
 * is escaped once, by {@link mapsDestinations}, and organiser text cannot end
 * the query value or add a parameter (Waze's `navigate=`) of its own.
 */
const SEARCH = {
  google: (q) => `${GOOGLE_MAPS_SEARCH}${q}`,
  apple: (q) => `https://maps.apple.com/?q=${q}`,
  waze: (q) => `https://waze.com/ul?q=${q}&navigate=yes`,
} as const satisfies Record<MapsProvider, (q: string) => string>;

/**
 * Google's own domains, each a host Google holds outright: `google.com`, and
 * country domains that are either a country's top level (`google.de`) or sit
 * under a second level its registry runs (`google.co.uk`, `google.com.au`). A
 * closed list rather than a pattern: under a country whose registry runs no
 * `co.` or `com.`, `google.com.de` is an ordinary domain anyone may register.
 * It names the countries an organiser is likely to paste a link from; a link
 * from any other is still shown, as "Venue map".
 */
const GOOGLE_DOMAINS = [
  "google.com",
  "google.co.uk",
  "google.com.au",
  "google.co.nz",
  "google.ca",
  "google.ie",
  "google.de",
  "google.fr",
  "google.es",
  "google.it",
  "google.nl",
  "google.co.in",
  "google.com.sg",
  "google.co.za",
  "google.com.br",
  "google.co.jp",
] as const;

/** Each of {@link GOOGLE_DOMAINS}, bare and under `www.` and `maps.`. */
const GOOGLE_HOSTS: ReadonlySet<string> = new Set(
  GOOGLE_DOMAINS.flatMap((domain) => [domain, `www.${domain}`, `maps.${domain}`]),
);

/**
 * Which map app an organiser's link opens, or null for any other site. A
 * Google host counts only under `/maps` (or on `maps.`), since the same hosts
 * serve search; `goo.gl` only under `/maps/`, since it shortened every kind
 * of link. A miss costs the link its label, not its safety: the organiser
 * wrote it, and it is shown as the venue's own map.
 */
function providerOf(url: URL): MapsProvider | null {
  const host = url.hostname;
  if (GOOGLE_HOSTS.has(host)) {
    return host.startsWith("maps.") || url.pathname.startsWith("/maps") ? "google" : null;
  }
  if (host === "maps.app.goo.gl" || host === "g.page") return "google";
  if (host === "goo.gl") return url.pathname.startsWith("/maps/") ? "google" : null;
  if (host === "maps.apple.com" || host.endsWith(".maps.apple.com") || host === "maps.apple") {
    return "apple";
  }
  if (host === "waze.com" || host.endsWith(".waze.com")) return "waze";
  return null;
}

/** One way to open the venue in a map: its words, and where it goes. */
export interface MapsDestination {
  label: string;
  href: string;
}

/**
 * Every map "Open in maps" offers for the venue: Google Maps, Apple Maps and
 * Waze, each searching for {@link venueQuery}, `encodeURIComponent`-escaped.
 *
 * The organiser's own http(s) `mapsUrl` — a pinned entrance or car park —
 * takes the place of the provider whose link it is ({@link providerOf}); a
 * link to any other site leads the list as "Venue map". With nothing to search
 * for, the organiser's link is the whole list, and with neither the list is
 * empty. So it has something in it exactly when `resolveMapsUrl` does, which
 * is what `hasVenue` and the venue row ask.
 */
export function mapsDestinations(
  event: Pick<EventSummary, "mapsUrl" | "address" | "venueName">,
): MapsDestination[] {
  const direct = organiserMapsUrl(event);
  const own = direct ? providerOf(direct.url) : null;
  const query = venueQuery(event);
  const q = query ? encodeURIComponent(query) : null;
  const out: MapsDestination[] = [];
  if (direct && !own) out.push({ label: "Venue map", href: direct.text });
  for (const provider of MAPS_PROVIDERS) {
    if (direct && provider === own) {
      out.push({ label: PROVIDER_LABEL[provider], href: direct.text });
    } else if (q) {
      out.push({ label: PROVIDER_LABEL[provider], href: SEARCH[provider](q) });
    }
  }
  return out;
}
