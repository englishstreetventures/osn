import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chooseMember,
  chosenMember,
  hasMemberStep,
  memberRequired,
  withChosenMember,
  withoutMember,
} from "../../src/components/household-member";
import type { ClaimResult, FamilyMember } from "../../src/components/types";

const member = (firstName: string, plusOneOf: string | null = null): FamilyMember => ({
  guestId: `g-${firstName}`,
  firstName,
  lastName: "Okafor",
  nickname: null,
  eventIds: [],
  plusOneOf,
});

const result = (members: FamilyMember[], extra: Partial<ClaimResult> = {}): ClaimResult => ({
  publicId: "X",
  familyName: "Okafor",
  members,
  events: [],
  rsvps: [],
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("the member step", () => {
  it("is on only when the payload carries a member, and never in preview", () => {
    expect(hasMemberStep(result([member("Ada")]))).toBe(false);
    expect(hasMemberStep(result([member("Ada")], { member: null }))).toBe(true);
    expect(hasMemberStep(result([member("Ada")], { member: null, preview: true }))).toBe(false);
    expect(hasMemberStep(null)).toBe(false);
  });

  it("needs a choice only from a household of two or more invited members", () => {
    expect(memberRequired(result([member("Ada"), member("Ravi")], { member: null }))).toBe(true);
    expect(memberRequired(result([member("Ada"), member("Sam", "g-Ada")], { member: null }))).toBe(
      false,
    );
    expect(
      memberRequired(result([member("Ada"), member("Ravi")], { member: { guestId: "g-Ada" } })),
    ).toBe(false);
    expect(memberRequired(result([member("Ada"), member("Ravi")]))).toBe(false);
  });

  it("names the chosen member", () => {
    const r = result([member("Ada"), member("Ravi")], { member: { guestId: "g-Ravi" } });
    expect(chosenMember(r)?.firstName).toBe("Ravi");
  });

  it("takes the API's link state with the choice, and drops the sign-in with Not you?", () => {
    const r = result([member("Ada")], {
      member: null,
      accountLink: { enabled: true, signedIn: true, linkedGuestIds: ["g-Ada"] },
    });
    const chosen = withChosenMember(r, "g-Ada", { enabled: false });
    expect(chosen.member).toEqual({ guestId: "g-Ada" });
    expect(chosen.accountLink).toEqual({ enabled: false });
    expect(withoutMember(r).accountLink).toEqual({
      enabled: true,
      signedIn: false,
      linkedGuestIds: ["g-Ada"],
    });
  });

  it("answers null when the API refuses the choice or cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))),
    );
    expect(await chooseMember("https://api.test", "g-Ada")).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    expect(await chooseMember("https://api.test", "g-Ada")).toBeNull();
  });
});
