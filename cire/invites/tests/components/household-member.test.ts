import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chooseMember,
  chosenMember,
  hasMemberStep,
  memberRequired,
  notYou,
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

describe("Not you?", () => {
  /** Answers the member DELETE and the musubi sign-out with the given statuses. */
  function answering(member: number, signout: number) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        calls.push(`${init?.method} ${url}`);
        const status = url.endsWith("/api/claim/member") ? member : signout;
        return Promise.resolve(new Response(null, { status }));
      }),
    );
    return calls;
  }

  it("is done when the server cleared the member and the sign-in", async () => {
    const calls = answering(204, 200);
    expect(await notYou("https://api.test")).toBe(true);
    expect(calls.sort()).toEqual([
      "DELETE https://api.test/api/claim/member",
      "POST https://api.test/api/auth/signout",
    ]);
  });

  it("is not done when either request failed", async () => {
    answering(503, 200);
    expect(await notYou("https://api.test")).toBe(false);
    answering(204, 500);
    expect(await notYou("https://api.test")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    expect(await notYou("https://api.test")).toBe(false);
  });
});
