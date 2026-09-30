import { describe, expect, it } from "vitest";

import { invitedMembers, isPlusOne } from "../../src/components/plus-one";
import type { FamilyMember } from "../../src/components/types";

const bo: FamilyMember = {
  guestId: "g-bo",
  firstName: "Bo",
  lastName: "Lee",
  nickname: null,
  eventIds: ["e1", "e2"],
  plusOneAllowed: true,
  plusOneOf: null,
};
const cleo: FamilyMember = {
  guestId: "g-cleo",
  firstName: "Cleo",
  lastName: "Lee",
  nickname: null,
  eventIds: ["e1"],
  plusOneAllowed: false,
  plusOneOf: null,
};
const sam: FamilyMember = {
  guestId: "g-sam",
  firstName: "Sam",
  lastName: "Park",
  nickname: null,
  eventIds: ["e1", "e2"],
  plusOneAllowed: false,
  plusOneOf: "g-bo",
};

describe("isPlusOne / invitedMembers", () => {
  it("tells a plus-one from the household's own members", () => {
    expect(isPlusOne(sam)).toBe(true);
    expect(isPlusOne(bo)).toBe(false);
    // An API that predates the field sends no `plusOneOf`: an ordinary member.
    expect(isPlusOne({ plusOneOf: undefined })).toBe(false);
  });

  it("keeps only the members the couple invited", () => {
    expect(invitedMembers([bo, sam, cleo])).toEqual([bo, cleo]);
  });
});
