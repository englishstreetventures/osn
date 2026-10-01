import { describe, expect, it } from "bun:test";

import {
  DIETARY_CONSENT_VERSION as SEED_DIETARY_CONSENT_VERSION,
  ORGANISER_DIETARY_CONSENT_VERSION as SEED_ORGANISER_DIETARY_CONSENT_VERSION,
} from "@cire/db/seed";
import { DIETARY_PRESETS, ORGANISER_DIETARY_ATTESTATION } from "@cire/dietary";
import { Schema } from "effect";

import {
  BulkRsvpBody,
  DIETARY_CONSENT_VERSION,
  OrganiserRsvpBody,
  RsvpBody,
} from "../../src/schemas/rsvp";

// v4 replaces Either with Result: the tags are "Success"/"Failure", not
// "Right"/"Left".
const dec = <A>(s: Schema.Codec<A>, v: unknown) => Schema.decodeUnknownResult(s)(v);

const base = {
  guestId: "b0000000-0000-4000-8000-000000000001",
  eventId: "9f7a2c14-1b3d-4e5f-8a01-000000000003",
  status: "attending",
  dietaryConsent: true,
} as const;

/**
 * The preset union and its length cap are the only things standing between an
 * arbitrary client and the `rsvps.dietary_presets` column — special-category
 * data under GDPR Art. 9. Nothing downstream re-checks: `parsePresets` is
 * deliberately total and silently drops what it does not recognise, so a widened
 * union is invisible from every other test in this suite.
 *
 * `DietaryPresets` is module-private, so it is reached through the three bodies
 * that embed it. Each is asserted, because each is a separate `Schema.Struct`
 * and a field dropped from one of them would not show up in the others.
 */
describe("dietary presets in the RSVP bodies", () => {
  it("accepts every key in the vocabulary", () => {
    expect(dec(RsvpBody, { ...base, dietaryPresets: [...DIETARY_PRESETS] })._tag).toBe("Success");
  });

  it("rejects a key outside the vocabulary", () => {
    expect(dec(RsvpBody, { ...base, dietaryPresets: ["vegetarian", "gluten_free"] })._tag).toBe(
      "Failure",
    );
    // Case matters — the column stores exactly what the union admits.
    expect(dec(RsvpBody, { ...base, dietaryPresets: ["Vegetarian"] })._tag).toBe("Failure");
    expect(dec(RsvpBody, { ...base, dietaryPresets: [""] })._tag).toBe("Failure");
  });

  it("admits a repeated key, because the server canonicalises rather than rejects", () => {
    // `serialisePresets` deduplicates and the server stores what it serialises,
    // so a repeat is a normalisation, not a 422. Pinned because it is the only
    // reason the cap below can be reached at all.
    expect(dec(RsvpBody, { ...base, dietaryPresets: ["nuts", "nuts", "nuts"] })._tag).toBe(
      "Success",
    );
  });

  it("caps the array at the size of the vocabulary", () => {
    // The cap is `DIETARY_PRESETS.length`, so an over-length array cannot hold
    // distinct keys — 17 entries necessarily repeat one. That is the only
    // fixture that can exercise the bound.
    const atCap = [...DIETARY_PRESETS];
    expect(atCap).toHaveLength(16);
    expect(dec(RsvpBody, { ...base, dietaryPresets: atCap })._tag).toBe("Success");
    expect(dec(RsvpBody, { ...base, dietaryPresets: [...atCap, "nuts"] })._tag).toBe("Failure");
  });

  it("defaults to an empty selection when the field is absent", () => {
    const result = dec(RsvpBody, base);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success.dietaryPresets).toEqual([]);
  });

  it("applies the same union and cap on the bulk body", () => {
    expect(dec(BulkRsvpBody, { rsvps: [{ ...base, dietaryPresets: ["halal"] }] })._tag).toBe(
      "Success",
    );
    expect(dec(BulkRsvpBody, { rsvps: [{ ...base, dietaryPresets: ["not_a_preset"] }] })._tag).toBe(
      "Failure",
    );
    expect(
      dec(BulkRsvpBody, { rsvps: [{ ...base, dietaryPresets: [...DIETARY_PRESETS, "nuts"] }] })
        ._tag,
    ).toBe("Failure");
  });

  it("applies the same union and cap on the organiser body", () => {
    // The organiser body takes guest and event from the path, so it carries
    // only the answer.
    const organiser = { status: "attending", dietaryConsent: true } as const;
    expect(dec(OrganiserRsvpBody, { ...organiser, dietaryPresets: ["kosher"] })._tag).toBe(
      "Success",
    );
    expect(dec(OrganiserRsvpBody, { ...organiser, dietaryPresets: ["kosher!"] })._tag).toBe(
      "Failure",
    );
    expect(
      dec(OrganiserRsvpBody, { ...organiser, dietaryPresets: [...DIETARY_PRESETS, "nuts"] })._tag,
    ).toBe("Failure");
  });

  it("leaves the organiser body's dietary fields absent when the body omits them", () => {
    const statusOnly = dec(OrganiserRsvpBody, { status: "maybe" });
    expect(statusOnly).toMatchObject({
      _tag: "Success",
      success: { status: "maybe", dietaryConsent: false },
    });
    if (statusOnly._tag !== "Success") throw new Error("unreachable");
    expect("dietary" in statusOnly.success).toBe(false);
    expect("dietaryPresets" in statusOnly.success).toBe(false);

    const presetsOnly = dec(OrganiserRsvpBody, { status: "maybe", dietaryPresets: [] });
    if (presetsOnly._tag !== "Success") throw new Error("expected success");
    expect(presetsOnly.success.dietaryPresets).toEqual([]);
    expect("dietary" in presetsOnly.success).toBe(false);
  });
});

describe("OrganiserRsvpBody.dietaryAttestation", () => {
  const organiser = { status: "attending" } as const;
  it("defaults to an empty string, so a status-only reply needs none", () => {
    const r = dec(OrganiserRsvpBody, organiser);
    expect(r._tag).toBe("Success");
    if (r._tag === "Success") expect(r.success.dietaryAttestation).toBe("");
  });
  it("accepts 64 characters and refuses 65", () => {
    expect(dec(OrganiserRsvpBody, { ...organiser, dietaryAttestation: "x".repeat(64) })._tag).toBe(
      "Success",
    );
    expect(dec(OrganiserRsvpBody, { ...organiser, dietaryAttestation: "x".repeat(65) })._tag).toBe(
      "Failure",
    );
  });
});

/**
 * `@cire/db` cannot import these constants, so its seed holds copies. A copy
 * that drifts seeds rows the live write path can no longer produce.
 */
describe("seeded consent versions", () => {
  it("match the versions the API stamps", () => {
    expect(SEED_DIETARY_CONSENT_VERSION).toBe(DIETARY_CONSENT_VERSION);
    expect(SEED_ORGANISER_DIETARY_CONSENT_VERSION).toBe(ORGANISER_DIETARY_ATTESTATION.version);
  });
});
