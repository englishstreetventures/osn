import { describe, expect, it } from "bun:test";

import { ownerOnlySettingsIn, UpdateSettingsBody } from "./settings";

/**
 * `ownerOnlySettingsIn` is the allow-list behind `PUT /settings`'s field-level
 * owner check: an `editor` co-host may write the RSVP deadline and nothing
 * else. The route tests cover it over HTTP; these pin the invariants that a
 * JSON body can't reach — the `undefined` branch (PATCH "absent ≠ clear"), and
 * the agreement with `weddingSettingsService.update`'s prototype-chain reads.
 */
describe("ownerOnlySettingsIn", () => {
  it("allows an empty patch", () => {
    expect(ownerOnlySettingsIn({})).toEqual([]);
  });

  it("allows the deadline pair", () => {
    expect(
      ownerOnlySettingsIn({ rsvpDeadline: "2027-02-20", rsvpDeadlineTimezone: "Australia/Sydney" }),
    ).toEqual([]);
  });

  it("allows clearing the deadline — an explicit null on a writable field", () => {
    expect(ownerOnlySettingsIn({ rsvpDeadline: null, rsvpDeadlineTimezone: null })).toEqual([]);
  });

  it("names only the owner-only keys in a mixed patch", () => {
    expect(
      ownerOnlySettingsIn({
        displayName: "Renamed",
        guestCountEstimate: 40,
        rsvpDeadline: "2027-02-20",
      }).toSorted(),
    ).toEqual(["displayName", "guestCountEstimate"]);
  });

  it("treats an explicit null on an owner-only field as a write", () => {
    // Clearing is the destructive half of a write. A truthiness check here
    // would let a co-host wipe the wedding date, guest estimate and budget.
    expect(ownerOnlySettingsIn({ weddingDate: null })).toEqual(["weddingDate"]);
    expect(ownerOnlySettingsIn({ budgetTotalMinor: null })).toEqual(["budgetTotalMinor"]);
  });

  it("ignores an explicit undefined — absent, not cleared", () => {
    // The writer skips `undefined` too (`patch.X !== undefined`), so the gate
    // must agree or it would refuse a patch that changes nothing.
    expect(ownerOnlySettingsIn({ displayName: undefined, rsvpDeadline: "2027-02-20" })).toEqual([]);
  });

  it("reads inherited keys, because the writer does (S-M1)", () => {
    // `update` decides what to write with `patch.displayName !== undefined`,
    // which walks the prototype chain; a gate reading only OWN keys would
    // disagree and wave through a field the writer then writes. No pollution
    // sink exists today — this keeps the agreement structural rather than
    // dependent on that staying true.
    const polluted = Object.create({ displayName: "POLLUTED" }) as Record<string, unknown>;
    polluted.rsvpDeadline = "2027-02-20";
    expect(ownerOnlySettingsIn(polluted as never)).toEqual(["displayName"]);
  });

  it("covers every field the body accepts", () => {
    // Drift guard: the key list IS the schema, so a field added to
    // UpdateSettingsBody is owner-only from the moment it exists.
    const fields = Object.keys(UpdateSettingsBody.fields).toSorted();
    const editorWritable = new Set(["rsvpDeadline", "rsvpDeadlineTimezone"]);
    const everyFieldSet = Object.fromEntries(fields.map((f) => [f, null]));
    expect(ownerOnlySettingsIn(everyFieldSet as never).toSorted()).toEqual(
      fields.filter((f) => !editorWritable.has(f)),
    );
  });
});
