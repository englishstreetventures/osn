// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { LinkPill } from "../../src/components/LinkPill";

afterEach(cleanup);

describe("LinkPill", () => {
  it.each([
    ["a script", "javascript:alert(1)"],
    ["a data document", "data:text/html,<script>alert(1)</script>"],
    ["a relative path", "/vendors/acme"],
    ["no address at all", ""],
  ])("draws nothing for %s", (_label, href) => {
    // A vendor or a co-host types many of these, and a `javascript:` link
    // would run in the portal's own origin, whatever the caller checked.
    render(() => <LinkPill href={href}>Website</LinkPill>);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each(["https://acme.example/", "http://localhost:4321/cire/invite?slug=a"])(
    "links %s in a new tab with no opener handle",
    (href) => {
      render(() => <LinkPill href={href}>Website</LinkPill>);
      const link = screen.getByRole("link");
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    },
  );
});
