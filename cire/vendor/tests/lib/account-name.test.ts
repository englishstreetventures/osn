import { describe, expect, it } from "vitest";

import { accountName } from "../../src/lib/account-name";

/*
 * The name the account menu heads with and the account circle takes its
 * initial from: the best the session has, in order, and never empty, so the
 * circle never shows a blank before the session arrives.
 */
describe("accountName", () => {
  it.each([
    [
      "the display name first",
      { displayName: "Acme Florals", handle: "acme", email: "a@acme.test" },
      "Acme Florals",
    ],
    ["then the handle", { displayName: null, handle: "acme", email: "a@acme.test" }, "acme"],
    ["then the email", { displayName: null, handle: null, email: "a@acme.test" }, "a@acme.test"],
    ["then words of its own", { displayName: null, handle: null, email: null }, "Your account"],
  ])("takes %s", (_, session, name) => {
    expect(accountName(session as never)).toBe(name);
  });

  it("names a session that has not arrived", () => {
    expect(accountName(undefined)).toBe("Your account");
    expect(accountName(null)).toBe("Your account");
  });
});
