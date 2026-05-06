import { describe, it, expect } from "vitest";
import { isValidPinterestUrl, toEmbedUrl } from "./pinterest";

describe("isValidPinterestUrl", () => {
  it.each([
    "https://pinterest.com/user/board",
    "https://www.pinterest.com/user/board",
    "https://pinterest.com/user/board/",
    "https://www.pinterest.com.au/user/board",
    "https://pinterest.co.uk/user/board",
    "https://www.pinterest.co.uk/user/wedding-inspo/",
  ])("accepts %s", (url) => {
    expect(isValidPinterestUrl(url)).toBe(true);
  });

  it.each([
    "http://pinterest.com/user/board", // not https
    "https://pinterest.fr/user/board", // unsupported tld
    "https://pinterest.com/user", // missing board path
    "https://pinterest.com/", // root only
    "https://evil.com/user/board", // foreign host
    "https://pinterest.com.evil.com/user/board", // host injection
    "javascript:alert(1)", // js scheme
    "https://pinterest.com/user/board/extra", // extra path segment
    "https://pinterest.com/user with spaces/board", // whitespace in segment
    "https://pinterest.com/user/board?utm=evil", // querystring
    "https://pinterest.com/user/board#frag", // fragment
    "", // empty
  ])("rejects %s", (url) => {
    expect(isValidPinterestUrl(url)).toBe(false);
  });
});

describe("toEmbedUrl", () => {
  it("appends /embed to a valid board url", () => {
    expect(toEmbedUrl("https://pinterest.com/user/board")).toBe(
      "https://pinterest.com/user/board/embed",
    );
  });

  it("normalises a trailing slash before appending /embed", () => {
    expect(toEmbedUrl("https://www.pinterest.com.au/user/wedding-inspo/")).toBe(
      "https://www.pinterest.com.au/user/wedding-inspo/embed",
    );
  });

  it("returns null for invalid input", () => {
    expect(toEmbedUrl("https://evil.com/user/board")).toBeNull();
    expect(toEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(toEmbedUrl("")).toBeNull();
  });
});
