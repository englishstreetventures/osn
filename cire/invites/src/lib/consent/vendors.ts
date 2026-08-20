import type { ConsentCategory } from "./categories";

/**
 * The vendor registry — ONE source of truth for every third party the guest
 * site can cause a browser to contact.
 *
 * This exists because the same facts were previously maintained in four places
 * that drifted independently: the consent copy inside `PinterestBoard.tsx`, the
 * `/privacy` page's prose, the `ORIGINS` allowlist in `lib/security-headers.ts`,
 * and the `wiki/compliance/subprocessors.md` table. Adding a vendor meant four
 * edits, and forgetting one produced either a CSP block (loud) or an undeclared
 * data transfer (silent, and the one that matters). Now the registry drives the
 * preferences dialog and the privacy page directly, and `vendors.test.ts`
 * asserts that every declared origin is actually present in the CSP — so a
 * vendor added here without a matching CSP entry fails the build's test run
 * rather than failing in a guest's browser.
 *
 * ## `enforcement` — the honest bit
 *
 * A registry that lists a vendor the consent gate doesn't actually block would
 * be a lie told in a compliance-shaped voice, so each vendor states plainly
 * whether consent is enforced for it:
 *
 *  - `"gated"` — the browser makes NO request to this vendor until the guest
 *    grants its category. Pinterest and Google Maps are both gated: their
 *    components mount inside the click-opened details sheet, so nothing is in
 *    the server-rendered HTML and a client-side gate is genuinely sufficient.
 *  - `"always"` — loads on every visit regardless of the guest's choice. Used
 *    for first-party necessities (the session cookie, the consent record
 *    itself) and Turnstile, which the claim form cannot function without.
 *    Google Fonts used to be the one third party in this bucket — its `<link>`
 *    lived in the `<head>` of the server-rendered document, so gating it would
 *    have either swapped the typeface mid-visit or left the prerendered legal
 *    pages inconsistent with the SSR'd invite. Self-hosting the two woff2
 *    families (tracker #98) removed the vendor from this table entirely rather
 *    than gating it.
 *
 * The preferences dialog surfaces this distinction rather than hiding it: an
 * `"always"` vendor is listed with a plain "loads on every visit" note instead
 * of being tucked under a toggle that doesn't govern it.
 */
export type ConsentEnforcement = "gated" | "always";

export interface ConsentVendor {
  /** Stable id — referenced by `<ConsentGate vendor="...">` and by tests. */
  readonly id: string;
  /** Display name, as the guest should recognise it. */
  readonly name: string;
  readonly category: ConsentCategory;
  /** Plain-English "what it does for you", shown in the dialog + privacy page. */
  readonly purpose: string;
  /**
   * Origins this vendor causes the browser to contact. First-party-only vendors
   * (the session cookie, the consent record itself) declare `[]`. Every entry
   * here MUST appear somewhere in `CSP_DIRECTIVES` — asserted by the tests.
   */
  readonly origins: readonly string[];
  /** Whether the consent gate actually blocks it. See the module doc. */
  readonly enforcement: ConsentEnforcement;
  /** The vendor's own privacy policy; `null` for first-party storage. */
  readonly privacyUrl: string | null;
  /** Where the data ends up, for the privacy-page transfer column. */
  readonly transfer: string | null;
}

export const CONSENT_VENDORS: readonly ConsentVendor[] = [
  {
    id: "cire-session",
    name: "Your invite session",
    category: "necessary",
    purpose:
      "Keeps you signed in to your invite after you enter your family code, so you don't have to type it again on every page.",
    origins: [],
    enforcement: "always",
    privacyUrl: null,
    transfer: null,
  },
  {
    id: "consent-record",
    name: "Your privacy choices",
    category: "necessary",
    purpose:
      "Remembers the choices you make here, so we don't ask again on every visit. Storing this is what lets us honour a refusal.",
    origins: [],
    enforcement: "always",
    privacyUrl: null,
    transfer: null,
  },
  {
    id: "turnstile",
    name: "Cloudflare Turnstile",
    category: "necessary",
    purpose:
      "Checks that a real person is entering the family code, so the invite can't be opened by automated guessing.",
    origins: ["https://challenges.cloudflare.com"],
    enforcement: "always",
    privacyUrl: "https://www.cloudflare.com/privacypolicy/",
    transfer: "Cloudflare, Inc. (US)",
  },
  {
    id: "google-maps",
    name: "Google Maps",
    category: "embeds",
    purpose: "Shows an interactive map of each venue inside the event details.",
    origins: ["https://www.google.com", "https://maps.gstatic.com", "https://maps.googleapis.com"],
    enforcement: "gated",
    privacyUrl: "https://policies.google.com/privacy",
    transfer: "Google LLC (US)",
  },
  {
    id: "pinterest",
    name: "Pinterest",
    category: "embeds",
    purpose: "Shows the couple's inspiration moodboard for an event's dress code.",
    origins: [
      "https://assets.pinterest.com",
      "https://widgets.pinterest.com",
      "https://i.pinimg.com",
    ],
    enforcement: "gated",
    privacyUrl: "https://policy.pinterest.com/privacy-policy",
    transfer: "Pinterest, Inc. (US)",
  },
] as const;

/** Look a vendor up by id. Returns `undefined` for an unknown id. */
export function vendorById(id: string): ConsentVendor | undefined {
  return CONSENT_VENDORS.find((vendor) => vendor.id === id);
}

/** Every vendor in a category, registry order preserved. */
export function vendorsInCategory(category: ConsentCategory): readonly ConsentVendor[] {
  return CONSENT_VENDORS.filter((vendor) => vendor.category === category);
}

/**
 * Vendors in a category whose loading the consent choice actually controls —
 * what the dialog lists under the toggle itself.
 */
export function gatedVendorsInCategory(category: ConsentCategory): readonly ConsentVendor[] {
  return vendorsInCategory(category).filter((vendor) => vendor.enforcement === "gated");
}

/**
 * Vendors in a category that load regardless of the toggle — listed separately
 * and labelled, so the dialog never implies a switch governs something it
 * doesn't.
 */
export function ungatedVendorsInCategory(category: ConsentCategory): readonly ConsentVendor[] {
  return vendorsInCategory(category).filter(
    (vendor) => vendor.enforcement === "always" && vendor.origins.length > 0,
  );
}

/** Third parties (i.e. vendors that contact an external origin), for the privacy page. */
export function thirdPartyVendors(): readonly ConsentVendor[] {
  return CONSENT_VENDORS.filter((vendor) => vendor.origins.length > 0);
}
