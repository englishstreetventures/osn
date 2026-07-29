// @vitest-environment happy-dom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { MobileNav } from "../../src/components/MobileNav";
import { isNavActive } from "../../src/components/nav";

afterEach(() => {
  cleanup();
});

function renderNav() {
  return render(() => (
    <MemoryRouter root={(props) => <>{props.children}</>}>
      <Route path="*" component={MobileNav} />
    </MemoryRouter>
  ));
}

describe("<MobileNav />", () => {
  it("renders the four primary nav links with hrefs", () => {
    const result = renderNav();
    for (const [label, href] of [
      ["Connections", "/connections"],
      ["Discover", "/discover"],
      ["Organisations", "/organisations"],
      ["Settings", "/settings"],
    ] as const) {
      const link = result.getByText(label).closest("a");
      expect(link?.getAttribute("href")).toBe(href);
    }
  });

  it("is the mobile shell: hidden at md and up, fixed to the bottom edge", () => {
    const result = renderNav();
    const nav = result.getByLabelText("Primary");
    expect(nav.className).toContain("md:hidden");
    expect(nav.className).toContain("fixed");
    expect(nav.className).toContain("bottom-0");
  });
});

describe("isNavActive", () => {
  it("marks the exact path and sub-paths active", () => {
    expect(isNavActive("/organisations", "/organisations")).toBe(true);
    expect(isNavActive("/organisations/org_1", "/organisations")).toBe(true);
    expect(isNavActive("/discover", "/organisations")).toBe(false);
  });

  it("treats the root path as Connections", () => {
    expect(isNavActive("/", "/connections")).toBe(true);
    expect(isNavActive("/", "/discover")).toBe(false);
  });
});
