// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import Globe from "lucide-solid/icons/globe";
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
    render(() => <LinkPill href={href} label="Website" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each(["https://acme.example/", "http://localhost:4321/cire/invite?slug=a"])(
    "links %s in a new tab with no opener handle",
    (href) => {
      render(() => <LinkPill href={href} label="Website" />);
      const link = screen.getByRole("link");
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    },
  );

  it("names a marked pill under the pointer by its word, since a narrow row shows the mark alone", () => {
    render(() => <LinkPill href="https://acme.example/" mark={Globe} label="Website" />);
    expect(screen.getByRole("link").getAttribute("title")).toBe("Website");
  });

  it("gives a pill with no mark no title, since its word always shows", () => {
    render(() => <LinkPill href="https://acme.example/" label="Website" />);
    expect(screen.getByRole("link").hasAttribute("title")).toBe(false);
  });
});
