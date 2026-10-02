import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", () => ({ apiUrl: (path: string) => `https://api.test${path}` }));

import { inviteImageSrc } from "../../src/lib/invite-image";

/**
 * The builder's thumbnail, crop editor and previews share this URL, so the
 * browser holds one copy of each image. A second spelling of the same bytes
 * (no variant here, `variant=card` there) is a second fetch.
 */
describe("inviteImageSrc", () => {
  it("asks for the card variant after the version the API hands out", () => {
    expect(inviteImageSrc("/api/organiser/weddings/wed_1/invite/image/footer?v=7")).toBe(
      "https://api.test/api/organiser/weddings/wed_1/invite/image/footer?v=7&variant=card",
    );
  });

  it("starts the query when the path has none", () => {
    expect(inviteImageSrc("/api/invite/anita-ben/image/hero")).toBe(
      "https://api.test/api/invite/anita-ben/image/hero?variant=card",
    );
  });
});
