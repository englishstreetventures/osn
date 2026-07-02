import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PulseHero } from "./PulseHero";

const baseProps = {
  appUrl: "https://app.example.com",
  howHref: "#how-it-works",
};

describe("PulseHero", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the editorial headline with its italic accent word", () => {
    const { getByRole, getByText } = render(() => <PulseHero {...baseProps} />);
    const heading = getByRole("heading", { level: 1 });
    expect(heading.textContent).toMatch(/Find what/i);
    expect(getByText("happening")).toBeTruthy();
  });

  it("falls back to the generic CTA when geo is unavailable", async () => {
    // No /api/geo in the test env, so the location-aware enhancement never
    // resolves and the hero keeps its generic copy + app-root CTA.
    const { getByRole } = render(() => <PulseHero {...baseProps} />);

    await waitFor(() => {
      const primary = getByRole("link", { name: /find events/i }) as HTMLAnchorElement;
      expect(primary.getAttribute("href")).toBe("https://app.example.com");
      const secondary = getByRole("link", { name: /how it works/i }) as HTMLAnchorElement;
      expect(secondary.getAttribute("href")).toBe("#how-it-works");
    });
  });

  it("upgrades to a location-aware line + city CTA when /api/geo resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ city: "Austin", region: "Texas", country: "US", count: 42 }),
      })),
    );

    const { findByRole, getByText } = render(() => <PulseHero {...baseProps} />);

    // Region drives the count line; city drives the CTA + ?near= target.
    const primary = (await findByRole("link", {
      name: /what.s on in austin/i,
    })) as HTMLAnchorElement;
    expect(primary.getAttribute("href")).toBe("https://app.example.com?near=Austin");
    expect(getByText(/42 events around Texas/i)).toBeTruthy();
  });

  it("labels the hero region for assistive tech", () => {
    const { getByRole } = render(() => <PulseHero {...baseProps} />);
    expect(getByRole("region", { name: /pulse — find your scene/i })).toBeTruthy();
  });
});
