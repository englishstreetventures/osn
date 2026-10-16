// @vitest-environment happy-dom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { MobileNav } from "../../src/components/MobileNav";
import { isNavActive, NAV_ITEMS } from "../../src/components/nav";

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
  it("sizes the grid to the number of tabs so none is clipped", () => {
    const result = renderNav();
    const row = result.getByLabelText("Primary").firstElementChild;
    expect(row?.className).toContain(`grid-cols-${NAV_ITEMS.length}`);
  });
});

describe("nav item split", () => {
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
