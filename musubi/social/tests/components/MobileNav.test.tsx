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
    // The only check that a new nav item gets its column class in MobileNav.
    const result = renderNav();
    const row = result.getByLabelText("Primary").firstElementChild;
    expect(row?.className).toContain(`grid-cols-${NAV_ITEMS.length}`);
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
