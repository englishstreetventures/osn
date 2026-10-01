/**
 * The attestation wordings for dietary requirements given on someone else's
 * behalf, each with the version that names it. A guest's own consent is
 * versioned by the API (`DIETARY_CONSENT_VERSION` in
 * `cire/api/src/schemas/rsvp.ts`); these are the other three.
 *
 * What a household confirms when it gives a plus-one's dietary requirements,
 * and the version that names those words.
 *
 * A plus-one never holds the household's code and never sees the invite, so
 * the household's tick for them is not the plus-one's own consent: it is the
 * household's confirmation that the plus-one agreed (GDPR Art. 9(2)(a), the
 * inviter-attested variant in `wiki/compliance/dpia/cire-guest-data.md`).
 *
 * The words and the version live in one constant, in the one package both
 * sides already share. The guest invite renders `text` beside the box and
 * sends `version` with the reply; the API refuses a plus-one's dietary data
 * unless the version sent is this one, and stamps this one onto the row. So a
 * guest site and an API built from different commits cannot store evidence
 * naming words that were not on screen: a mismatch is refused.
 *
 * Changing `text` means changing `version` in the same commit (the test beside
 * this file pins the two together). `wiki/compliance/data-map.md` names the
 * current version on the consent-record row and moves with it.
 */
export const PLUS_ONE_DIETARY_ATTESTATION = {
  /**
   * Stamped into `rsvps.dietary_consent_version` on a plus-one's attested
   * reply. Prefixed so it can never equal the guest's own-consent version, a
   * bare date: the stored value alone says which copy it names.
   */
  version: "inviter-2026-09-27",
  /** The sentence beside the box. `names` is every plus-one it covers,
   *  already joined ("Sam", "Sam and Alex"). */
  text: (names: string): string =>
    `I confirm that ${names} agreed to their dietary requirements above being stored and shared with the caterers for this wedding.`,
} as const;

/**
 * What an organiser confirms when they record a guest's dietary requirements
 * from a phone or paper reply, and the version that names those words.
 *
 * The organiser is not the guest, so their tick is an attestation that the
 * guest consented (GDPR Art. 9(2)(a), the organiser-attested variant in
 * `wiki/compliance/dpia/cire-guest-data.md`). The organiser portal renders
 * `text` beside the box and sends `version` with the reply; the API refuses the
 * reply's dietary data unless the version sent is this one, and stamps this one
 * onto the row. A portal and an API built from different commits therefore
 * cannot store evidence naming words that were not on screen.
 *
 * Changing `text` means changing `version` in the same commit (the test beside
 * this file pins the two together). `wiki/compliance/data-map.md` names the
 * current version on the consent-record row and moves with it, as do the copy
 * in `cire/db/seed/data/rsvps.ts` and the generated `cire/db/seed/dev-seed.sql`.
 */
export const ORGANISER_DIETARY_ATTESTATION = {
  /**
   * Stamped into `rsvps.dietary_consent_version` on an organiser-recorded
   * reply. Prefixed, like the household's, so the stored value alone says
   * which copy it names.
   */
  version: "organiser-2026-10-01",
  /** The sentence beside the box. */
  text: "I confirm the guest consented to their dietary requirements being stored and shared with the caterers for this wedding.",
} as const;

/**
 * What an organiser confirms when they record a plus-one's dietary
 * requirements from a phone or paper reply, and the version that names those
 * words.
 *
 * Its own wording, apart from the organiser's attestation for a guest, because
 * the person it speaks of is different: a plus-one never holds the household's
 * code, so what the organiser hears comes from the plus-one or from the
 * household that brought them. The tick is the organiser's confirmation that
 * the plus-one consented (GDPR Art. 9(2)(a), the organiser-attested variant in
 * `wiki/compliance/dpia/cire-guest-data.md`). The organiser portal renders
 * `text` beside the box on a plus-one's reply and sends `version`; the API
 * stores a plus-one's dietary data from the organiser only when the version
 * sent is this one, and stamps this one onto the row.
 *
 * Changing `text` means changing `version` in the same commit (the test beside
 * this file pins the two together). `wiki/compliance/data-map.md` names the
 * current version on the consent-record row and moves with it.
 */
export const ORGANISER_PLUS_ONE_DIETARY_ATTESTATION = {
  /**
   * Stamped into `rsvps.dietary_consent_version` on an organiser-recorded
   * plus-one's reply. Its stem (`organiser-plus-one`) differs from every other
   * copy's, so the stored value alone says which words it names.
   */
  version: "organiser-plus-one-2026-10-01",
  /** The sentence beside the box. */
  text: "I confirm the plus-one consented to their dietary requirements being stored and shared with the caterers for this wedding.",
} as const;
