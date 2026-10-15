import { describe, expect, it } from "vitest";

import { invitePath } from "../../src/lib/invite";

/**
 * The invitation is now linked TO, not only landed on: the gift list has its own
 * page and every way back from it — the sticky rail, the signed-out prompt, the
 * closed-list note — is this string. The slug stays in the query string for
 * newly generated links.
 */
describe("invitePath", () => {
  it("uses the fixed invitation path", () => {
    expect(invitePath("anita-and-ben")).toBe("/cire/invite?slug=anita-and-ben");
  });

  it("encodes a slug that would otherwise change the URL's shape", () => {
    expect(invitePath("a b")).toBe("/cire/invite?slug=a%20b");
    expect(invitePath("../other")).toBe("/cire/invite?slug=..%2Fother");
    expect(invitePath("a?b#c")).toBe("/cire/invite?slug=a%3Fb%23c");
  });
});
