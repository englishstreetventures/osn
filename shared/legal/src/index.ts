/**
 * The identity of the operator, as every published legal page must state it.
 *
 * ## Why this is a package
 *
 * Every privacy notice and terms page, on every product, names the same
 * operator, address, mailboxes, regulator and governing law. Holding them here
 * means one edit reaches every page, and each page's draft banner is derived
 * from these values rather than hand-maintained: `draftPending` stays true
 * while any value a page renders is still a `{{PLACEHOLDER}}`, so a page
 * cannot publish half-filled without saying so.
 *
 * ## What may live here
 *
 * Only what a published legal page must already say out loud: the operating
 * entity's name, its service address, its two mailboxes, its regulator and the
 * governing law. Naming the controller and how to contact it is a GDPR
 * Art. 13(1)(a) / APP 1.4 requirement, so none of it is confidential once a
 * notice is live.
 *
 * Nothing else. Company numbers, tax registrations, banking details and
 * commercial terms are not required on a notice and do not belong in the repo.
 */
export interface LegalEntity {
  /** Registered name, plus any trading name, exactly as it should be published. */
  readonly name: string;
  /** Service address for legal notices — a postal address, not a PO box alone. */
  readonly postalAddress: string;
  /**
   * Where a person exercises their privacy rights or complains: every privacy
   * notice names this one. Must be monitored by a human.
   */
  readonly privacyEmail: string;
  /**
   * Where everything else goes — refunds, tax invoices, questions about the
   * terms. Every terms page, the refund policy and the refund notices name
   * this one.
   */
  readonly supportEmail: string;
  /**
   * The supervisory authority a complaint goes to, named so a reader does not
   * have to find it. Australia's is the Office of the Australian Information
   * Commissioner; readers elsewhere are pointed at their own in the page copy.
   */
  readonly regulator: string;
  /**
   * Governing law, as "<state>, <country>". A state, because contract law and
   * the courts that hear a dispute are state matters; the consumer and privacy
   * law that protect a reader here are federal (the Australian Consumer Law and
   * the Privacy Act 1988 (Cth)) and apply whatever this says, and a consumer
   * keeps the protections of where they live. Pages follow it with "and the
   * courts of that state have non-exclusive jurisdiction".
   */
  readonly governingLaw: string;
}

/**
 * Fill the remaining `{{PLACEHOLDER}}` values before the pages are treated as
 * published — see `draftPending`, which every page calls to decide whether to
 * show its draft banner.
 */
export const LEGAL_ENTITY: LegalEntity = {
  name: "English Street Ventures Pty Ltd",
  postalAddress: "{{POSTAL_ADDRESS}}",
  privacyEmail: "privacy@englishstventures.com",
  supportEmail: "hello@englishstventures.com",
  regulator: "Office of the Australian Information Commissioner (OAIC)",
  governingLaw: "New South Wales, Australia",
};

/** A field still holding its `{{PLACEHOLDER}}` token. */
export function isPlaceholder(value: string): boolean {
  return value.startsWith("{{") && value.endsWith("}}");
}

/**
 * The fields every legal page renders, whatever else it says: the operator,
 * its address and both mailboxes (a privacy notice renders one mailbox and the
 * terms the other). This is the part of the draft banner no page has to ask
 * for.
 */
export const IDENTITY_FIELD_NAMES = [
  "name",
  "postalAddress",
  "privacyEmail",
  "supportEmail",
] as const satisfies readonly (keyof LegalEntity)[];

/**
 * True while any field every page renders is unfilled.
 *
 * The identity half of the draft banner, and only that half — no page reads it
 * directly, because a page also has to answer for the extra fields it names.
 * Call `draftPending` instead; this is what it checks on every caller's behalf.
 */
export const LEGAL_DETAILS_PENDING: boolean = IDENTITY_FIELD_NAMES.some((field) =>
  isPlaceholder(LEGAL_ENTITY[field]),
);

/**
 * Whether a page must show its draft banner.
 *
 * True while any field every page renders is unfilled, and true while any of
 * the extra fields THIS page publishes still is. Pass every non-identity field
 * the page names — the regulator, the governing law — and the banner cannot
 * outlive them. The identity half is checked here, so a caller cannot forget it.
 */
export function draftPending(...alsoRendered: readonly string[]): boolean {
  return LEGAL_DETAILS_PENDING || alsoRendered.some(isPlaceholder);
}
