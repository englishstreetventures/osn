import { describe, expect, it } from "vitest";

import { inviteTitle } from "./invite-title";

describe("inviteTitle", () => {
  it("composes the couple's hero title into the tab title", () => {
    expect(inviteTitle("Anita & Ben")).toBe("Anita & Ben — You're Invited");
  });

  it.each([null, undefined, ""])(
    "falls back to the built-in default for %s (never 'null — You're Invited')",
    (value) => {
      expect(inviteTitle(value)).toBe("You're Invited");
    },
  );
});
