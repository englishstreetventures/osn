/**
 * Consent categories — the unit a guest actually grants or refuses.
 *
 * The site-wide consent flow is category-based, not vendor-based: a guest
 * toggles "third-party embeds", not "Pinterest" and "Google Maps" separately.
 * Vendors declare which category they belong to (see `vendors.ts`), so adding a
 * third party is a registry entry rather than a new gate, a new storage key and
 * a new prompt — which is exactly what the bespoke Pinterest gate used to be.
 *
 * WHY THESE FOUR (and not the usual six-category cookie-banner boilerplate):
 * every category here maps to something the guest site genuinely does. We
 * deliberately do NOT define a `marketing` / `advertising` category — offering a
 * toggle for something we don't do invites the reasonable question of whether we
 * secretly do it, and an unused toggle is a claim we'd have to keep true.
 *
 * `necessary` is not optional and renders as a locked control. Under ePrivacy
 * (and the GDPR recitals behind it) storage that is strictly necessary to
 * provide the service the guest asked for needs no consent — the claim-code
 * session cookie, the bot check that protects it, and the record of this very
 * decision.
 *
 * ## `defaultGranted` — the opt-out posture
 *
 * The optional categories are OPT-OUT: `embeds` and `functional` apply to a
 * guest who has not yet decided, and the banner's job is to tell them so and
 * offer the off switch. This is a deliberate product decision for a private
 * wedding invite — the venue map and the moodboard are content the couple put
 * there for their guests, and making every guest click twice to see them costs
 * more than it protects. It sits within the Australian framing the site's
 * privacy notice sets out (a personal, family or household event, likely
 * outside the strict reach of the Privacy Act's APP entity rules). It is NOT
 * the standard ePrivacy posture for EU/UK visitors, who are entitled to prior
 * consent — a known, accepted trade rather than an oversight. Flipping back is
 * one field per category.
 *
 * `analytics` stays OFF by default even so, and the difference is the point.
 * Nothing uses that category today, so defaulting it on would mean any
 * analytics tag added later silently inherits consent from guests who were
 * never told it existed — the exact thing `CONSENT_POLICY_VERSION` exists to
 * prevent. A default may only cover things the guest was actually shown.
 */

/**
 * Every category, in the order the preferences dialog lists them (necessary
 * first, so the locked "this is the floor" row anchors the list).
 */
export const CONSENT_CATEGORIES = ["necessary", "functional", "embeds", "analytics"] as const;

export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export interface ConsentCategoryMeta {
  readonly id: ConsentCategory;
  /** Toggle label in the preferences dialog. */
  readonly title: string;
  /** One-sentence plain-English explanation shown under the label. */
  readonly summary: string;
  /**
   * Non-optional: always granted, rendered as a locked/checked control that
   * cannot be switched off. Only `necessary` is required.
   */
  readonly required: boolean;
  /**
   * Does this category apply to a guest who has NOT yet made a decision? See
   * the module doc — this is the opt-out switch, and it is per-category on
   * purpose so `analytics` can stay off while content categories are on.
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
      "Needed for the invite to work at all — keeping you signed in after you enter your code, checking you're not a bot, and remembering the privacy choices you make here. Always on.",
    required: true,
    defaultGranted: true,
  },
  functional: {
    id: "functional",
    title: "Preferences",
    summary:
      "Remembers choices you make while browsing your invite, so the page behaves the same way next time you open it.",
    required: false,
    // First-party only — nothing leaves your browser. On by default.
    defaultGranted: true,
  },
  embeds: {
    id: "embeds",
    title: "Third-party content",
    summary:
      "Lets us show content hosted by other companies — the Pinterest moodboard and the Google map of each venue. These load from the other company's servers, which means they can see your IP address and browser.",
    required: false,
    // On by default: this is content the couple put in the invite for their
    // guests, and the banner names the companies involved up front. See the
    // module doc for the trade this accepts.
    defaultGranted: true,
  },
  analytics: {
    id: "analytics",
    title: "Analytics",
    summary:
      "Anonymous statistics about how the invite is used, so we can fix what's broken. We don't use any analytics today — this switch exists so that if we ever add some, it starts switched off.",
    required: false,
    // OFF even though the other optional categories are on: there is nothing
    // here to disclose yet, so there is nothing a default could be informed
    // about. See the module doc.
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
