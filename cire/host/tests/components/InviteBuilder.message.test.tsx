// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The builder's Message section as a destination. A link elsewhere in the
 * dashboard can ask the builder to open on it rather than on the first
 * section, and the section carries the line pointing at the other places that
 * shape the message. The rest of the builder is `InviteBuilder.test.tsx`'s.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [{ id: "classic", name: "Classic", tier: "free" }],
  DEFAULT_DESIGN_ID: "classic",
}));

import InviteBuilder from "../../src/components/InviteBuilder";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

const CUSTOMISATION = {
  designId: "classic",
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    palettePreset: null,
    palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
    tones: { hero: null, story: null, details: null, welcome: null },
  },
};

function loadCustomisation() {
  authFetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(CUSTOMISATION), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const messageCard = () => document.getElementById("invite-message") as HTMLFieldSetElement;

describe("InviteBuilder Message section", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("opens on the first section when nothing asks otherwise", async () => {
    loadCustomisation();
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const design = await waitFor(() => screen.getByRole("tab", { name: "Design" }));
    expect(design.getAttribute("aria-selected")).toBe("true");
    expect(messageCard().hidden).toBe(true);
  });

  it("opens on the Message section when a link asked for it", async () => {
    loadCustomisation();
    render(() => (
      <InviteBuilder
        weddingId="wed_1"
        weddingSlug="anita-ben"
        entitlements={[]}
        initialSection="invite-message"
      />
    ));

    const message = await waitFor(() => screen.getByRole("tab", { name: "Message" }));
    expect(message.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Design" }).getAttribute("aria-selected")).toBe("false");
    expect(messageCard().hidden).toBe(false);
  });

  it("shows the invite-message links once, inside the Message section", async () => {
    loadCustomisation();
    render(() => (
      <InviteBuilder
        weddingId="wed_1"
        weddingSlug="anita-ben"
        entitlements={[]}
        inviteMessageLinks={<p data-testid="invite-message-links" />}
      />
    ));

    await waitFor(() => expect(messageCard()).toBeTruthy());
    const links = screen.getAllByTestId("invite-message-links");
    expect(links).toHaveLength(1);
    expect(messageCard().contains(links[0]!)).toBe(true);
  });
});
