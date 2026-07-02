import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionsHero } from "./ConnectionsHero";

// jsdom doesn't implement the canvas 2D context, so getContext returns null and
// the component's onMount bails out before any animation — exactly the path we
// want to assert against (static, no rAF). We also stub matchMedia so the
// reduced-motion branch is deterministic.
const baseProps = {
  appUrl: "https://app.example.com",
  exploreHref: "#apps",
};

function setReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: reduced,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

describe("ConnectionsHero", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    setReducedMotion(true);
  });

  it("renders the headline", () => {
    const { getByRole } = render(() => <ConnectionsHero {...baseProps} />);
    const heading = getByRole("heading", { level: 1 });
    expect(heading.textContent).toMatch(/your social graph/i);
  });

  it("renders both CTAs with the correct targets", () => {
    const { getByRole } = render(() => <ConnectionsHero {...baseProps} />);

    const primary = getByRole("link", { name: /get started/i }) as HTMLAnchorElement;
    expect(primary.getAttribute("href")).toBe("https://app.example.com");

    const secondary = getByRole("link", { name: /explore the ecosystem/i }) as HTMLAnchorElement;
    expect(secondary.getAttribute("href")).toBe("#apps");
  });

  it("renders even when reduced motion is off (no canvas context in jsdom)", () => {
    setReducedMotion(false);
    const { getByRole } = render(() => <ConnectionsHero {...baseProps} />);
    expect(getByRole("heading", { level: 1 })).toBeTruthy();
  });
});
