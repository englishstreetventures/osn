import { describe, expect, it } from "vitest";

import { invitePath } from "./invite";

/**
 * The invitation is now linked TO, not only landed on: the gift list has its own
 * page and every way back from it — the sticky rail, the signed-out prompt, the
 * closed-list note — is this string. A slug is organiser input, so it is encoded
 * for the same reason the API encodes one it puts in a URL: unencoded, `../`
 * climbs out of the wedding and `?`/`#` truncate the path, and the way home
 * silently goes somewhere else.
 */
describe("invitePath", () => {
  it("is the wedding's own path", () => {
    expect(invitePath("anita-and-ben")).toBe("/anita-and-ben");
  });

  it("encodes a slug that would otherwise change the URL's shape", () => {
    expect(invitePath("a b")).toBe("/a%20b");
    expect(invitePath("../other")).toBe("/..%2Fother");
    expect(invitePath("a?b#c")).toBe("/a%3Fb%23c");
  });
});
