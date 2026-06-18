import { describe, it, expect } from "vitest";

import { isEmbeddablePinterestBoardUrl, isSafePinterestLinkUrl } from "./pinterest";

describe("isSafePinterestLinkUrl", () => {
  it.each([
    // board URLs (with / without trailing slash)
    "https://pinterest.com/user/board",
    "https://www.pinterest.com/user/board/",
    "https://www.pinterest.com.au/example/catholic-wedding-guest-moodboard/",
    "https://pinterest.co.uk/user/wedding-inspo",
    // regional TLDs
    "https://pinterest.ca/user/board",
    "https://www.pinterest.de/user/board",
    // pin.it short links — must be a safe link target even though un-embeddable
    "https://pin.it/abc123",
    "https://pin.it/3xKp9Qd/",
    // profile-level + pin-level links are still safe to link out to
    "https://pinterest.com/user",
    "https://pinterest.com/pin/123456789",
    // board with a section sub-path
    "https://pinterest.com/user/board/section",
    // a querystring / fragment is fine for a plain outbound link
    "https://pinterest.com/user/board?utm=share",
    "https://www.pinterest.com/user/board#notes",
  ])("accepts %s", (url) => {
    expect(isSafePinterestLinkUrl(url)).toBe(true);
  });

  it.each([
    "http://pinterest.com/user/board", // not https
    "http://pin.it/abc123", // pin.it but not https
    "https://evil.com/user/board", // foreign host
    "https://pinterest.com.evil.com/user/board", // host-injection lookalike
    "https://notpinterest.com/user/board", // suffix lookalike
    "https://pin.it.evil.com/abc", // pin.it lookalike
    "javascript:alert(1)", // js scheme
    "data:text/html,<script>", // data scheme
    "", // empty
    "not a url", // unparseable
  ])("rejects %s", (url) => {
    expect(isSafePinterestLinkUrl(url)).toBe(false);
  });
});

describe("isEmbeddablePinterestBoardUrl", () => {
  it.each([
    "https://pinterest.com/user/board",
    "https://www.pinterest.com/user/board",
    "https://pinterest.com/user/board/", // trailing slash
    "https://www.pinterest.com.au/user/board",
    "https://pinterest.co.uk/user/board",
    "https://www.pinterest.co.uk/user/wedding-inspo/",
    "https://www.pinterest.com.au/example/catholic-wedding-guest-moodboard/",
    "https://pinterest.com/user/board/section", // board section sub-path
    "https://pinterest.com/user/board/section/", // section with trailing slash
  ])("accepts %s", (url) => {
    expect(isEmbeddablePinterestBoardUrl(url)).toBe(true);
  });

  it.each([
    "http://pinterest.com/user/board", // not https
    "https://pinterest.xyz/user/board", // unsupported tld
    "https://pinterest.com/user", // profile only — not a board
    "https://pinterest.com/", // root only
    "https://pin.it/abc123", // short link — not directly embeddable
    "https://evil.com/user/board", // foreign host
    "https://pinterest.com.evil.com/user/board", // host injection
    "javascript:alert(1)", // js scheme
    "https://pinterest.com/user/board/section/extra", // too deep
    "https://pinterest.com/user with spaces/board", // whitespace in segment
    "https://pinterest.com/user/board?utm=evil", // querystring
    "https://pinterest.com/user/board#frag", // fragment
    "", // empty
  ])("rejects %s", (url) => {
    expect(isEmbeddablePinterestBoardUrl(url)).toBe(false);
  });
});
