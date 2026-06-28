import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WaxSealHero } from "./WaxSealHero";

// Motion One is mocked so the choreography resolves instantly and we can assert
// on the resulting DOM state rather than animation frames.
vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
  stagger: vi.fn(() => 0),
}));

const baseProps = {
  heroImageId: "photo-test",
  heroImageAlt: "A test backdrop",
  organiserUrl: "https://host.example.com",
  demoHref: "#see-it-live",
  demoIsExternal: false,
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

describe("WaxSealHero", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    setReducedMotion(false);
  });

  it("renders the sealed envelope as an operable 'Open the invitation' control", () => {
    const { getByRole } = render(() => <WaxSealHero {...baseProps} />);
    expect(getByRole("button", { name: /open the invitation/i })).toBeTruthy();
  });

  it("reveals the headline and both CTAs with the correct targets when opened", async () => {
    const { getByRole, getByText } = render(() => <WaxSealHero {...baseProps} />);

    fireEvent.click(getByRole("button", { name: /open the invitation/i }));

    await waitFor(() => expect(getByText(/Invitations worthy/i)).toBeTruthy());

    await waitFor(() => {
      const primary = getByRole("link", { name: /create your invitation/i }) as HTMLAnchorElement;
      expect(primary.getAttribute("href")).toBe("https://host.example.com");
      const secondary = getByRole("link", { name: /see a live invite/i }) as HTMLAnchorElement;
      expect(secondary.getAttribute("href")).toBe("#see-it-live");
    });
  });

  it("snaps straight to the unveiled state under reduced motion (no interaction needed)", async () => {
    setReducedMotion(true);
    const { getByText } = render(() => <WaxSealHero {...baseProps} />);
    await waitFor(() => expect(getByText(/Invitations worthy/i)).toBeTruthy());
  });

  it("marks the secondary CTA as an external link when the demo is a real invite", async () => {
    const { getByRole } = render(() => (
      <WaxSealHero {...baseProps} demoHref="https://cireweddings.com/demo" demoIsExternal={true} />
    ));
    fireEvent.click(getByRole("button", { name: /open the invitation/i }));
    await waitFor(() => {
      const link = getByRole("link", { name: /see a live invite/i }) as HTMLAnchorElement;
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    });
  });
});
