import { describe, expect, it } from "bun:test";

import { DIETARY_PRESETS } from "@cire/dietary";
import { Schema } from "effect";

import { BulkRsvpBody, OrganiserRsvpBody, RsvpBody } from "../../src/schemas/rsvp";

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
});
