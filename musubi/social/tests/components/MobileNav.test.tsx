// @vitest-environment happy-dom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { MobileNav } from "../../src/components/MobileNav";
import { DESKTOP_NAV_ITEMS, isNavActive, NAV_ITEMS } from "../../src/components/nav";

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
  it("renders every primary nav link with hrefs, Search included", () => {
    const result = renderNav();
    for (const [label, href] of [
      ["Connections", "/connections"],
      ["Search", "/search"],
      ["Discover", "/discover"],
      ["Organisations", "/organisations"],
      ["Settings", "/settings"],
    ] as const) {
      const link = result.getByText(label).closest("a");
      expect(link?.getAttribute("href")).toBe(href);
    }
  });

  it("sizes the grid to the number of tabs so none is clipped", () => {
    const result = renderNav();
    const row = result.getByLabelText("Primary").firstElementChild;
    expect(row?.className).toContain(`grid-cols-${NAV_ITEMS.length}`);
  });

  it("is the mobile shell: hidden at md and up, fixed to the bottom edge", () => {
    const result = renderNav();
    const nav = result.getByLabelText("Primary");
    expect(nav.className).toContain("md:hidden");
    expect(nav.className).toContain("fixed");
    expect(nav.className).toContain("bottom-0");
  });
});

describe("nav item split", () => {
  it("keeps Search out of the desktop rail — the rail has a live search field", () => {
    expect(NAV_ITEMS.map((i) => i.href)).toContain("/search");
    expect(DESKTOP_NAV_ITEMS.map((i) => i.href)).not.toContain("/search");
  });

  it("has a grid-cols class for the current tab count", () => {
    // Guards the Tailwind static-class allow-list in MobileNav: adding a nav
    // item without adding its column class would silently clip the tab bar.
    expect([4, 5]).toContain(NAV_ITEMS.length);
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
