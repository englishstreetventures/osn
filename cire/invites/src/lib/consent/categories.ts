/**
 * Consent categories — the switches a guest actually grants or refuses.
 *
 * The guest site does no personal tracking. What it stores to work at all —
 * the claim-code session, the record of these very choices, the bot check
 * that protects the code — is strictly necessary, needs no consent under
 * ePrivacy, and is described in the privacy notice rather than switched here.
 * Consent is asked for exactly two things, each of which sends the guest's IP
 * address and browser to another company the moment it loads: the Pinterest
 * moodboard and the Google venue map. They are separate switches, so a guest
 * can allow one without the other.
 *
 * Vendors declare which category they belong to (see `vendors.ts`), so adding
 * a third party is a registry entry and a switch — never a new gate, a new
 * storage key and a new prompt of its own.
 *
 * ## `defaultGranted` — what applies before the guest decides
 *
 * Nothing optional. Both switches are OFF until the guest allows them — prior
 * consent, the ePrivacy posture for EU and UK visitors, applied to every
 * guest. The prompt asks on the first visit, and a guest who never answers it
 * simply never loads either.
 */

/**
 * Every category, in the order the preferences sheet lists the switches.
 * `necessary` is first and is never shown as a switch.
 */
export const CONSENT_CATEGORIES = ["necessary", "pinterest", "maps"] as const;

export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export interface ConsentCategoryMeta {
  readonly id: ConsentCategory;
  /** The switch's label in the preferences sheet, and in an embed's placeholder. */
  readonly title: string;
  /** One-sentence plain-English explanation shown under the label. */
  readonly summary: string;
  /**
   * Non-optional: always granted, never shown as a switch. Only `necessary`
   * is required.
   */
  readonly required: boolean;
  /**
   * Does this category apply to a guest who has NOT yet made a decision? See
   * the module doc. Only the required category does.
   *
   * Note this governs only the no-decision state. It has no bearing on what
   * "Reject all" writes (required categories only, always) or on what applies
   * before the stored decision has been read (also required only, so a guest
   * who refused never gets one load before their cookie is parsed).
   */
  readonly defaultGranted: boolean;
}

export const CATEGORY_META = {
  necessary: {
    id: "necessary",
    title: "Strictly necessary",
    summary:
      "Keeps you signed in after you enter your code, checks you're not a bot, and remembers these choices. Always on.",
    required: true,
    defaultGranted: true,
  },
  pinterest: {
    id: "pinterest",
    title: "Pinterest moodboards",
    summary:
      "Shows the couple's Pinterest moodboard inside an event's details. It loads from Pinterest's servers, which see your IP address and browser.",
    required: false,
    // OFF until the guest allows it. See the module doc.
    defaultGranted: false,
  },
  maps: {
    id: "maps",
    title: "Google Maps",
    summary:
      "Shows an interactive map of each venue inside an event's details. It loads from Google's servers, which see your IP address and browser.",
    required: false,
    // OFF until the guest allows it. See the module doc.
    defaultGranted: false,
  },
} satisfies Record<ConsentCategory, ConsentCategoryMeta>;

/** Ordered metadata list — what the preferences dialog iterates over. */
export const CATEGORY_LIST: readonly ConsentCategoryMeta[] = CONSENT_CATEGORIES.map(
  (id) => CATEGORY_META[id],
);

/** Is `value` one of the known categories? Guards decoded/persisted input. */
export function isConsentCategory(value: unknown): value is ConsentCategory {
  return typeof value === "string" && (CONSENT_CATEGORIES as readonly string[]).includes(value);
}

/** Categories that can never be switched off. */
export function isRequiredCategory(category: ConsentCategory): boolean {
  return CATEGORY_META[category].required;
}
