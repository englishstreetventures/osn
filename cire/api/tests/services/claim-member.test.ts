import { describe, expect, it } from "bun:test";

import { singleChoosableMember } from "../../src/services/claim";
import { withoutSubmitter } from "../../src/services/rsvp";

const m = (guestId: string, plusOneOf: string | null = null) => ({ guestId, plusOneOf });

describe("singleChoosableMember", () => {
  it("names the one invited member, whatever plus-ones sit beside them", () => {
    expect(singleChoosableMember([m("a")])).toBe("a");
    expect(singleChoosableMember([m("a"), m("p", "a")])).toBe("a");
  });

  it("names nobody for none or several", () => {
    expect(singleChoosableMember([])).toBeNull();
    expect(singleChoosableMember([m("a"), m("b")])).toBeNull();
  });
});

describe("withoutSubmitter", () => {
  it("drops only the sender", () => {
    expect(
      withoutSubmitter({ guestId: "g", status: "attending", submittedBy: { guestId: "s" } }),
    ).toEqual({ guestId: "g", status: "attending" });
  });
});
