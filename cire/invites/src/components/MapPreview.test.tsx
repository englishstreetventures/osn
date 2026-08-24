import { render, cleanup } from "@solidjs/testing-library";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { defaultGrants } from "../lib/consent/record";
import { grantCategory, saveConsent } from "../lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../lib/consent/testing";
import { MapPreview } from "./MapPreview";
import type { EventSummary } from "./types";

const baseEvent: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Mehndi",
  description: "An evening of henna",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane, Strathfield",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

describe("MapPreview", () => {
  beforeEach(resetConsentForTest);

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    resetConsentForTest();
  });

  it("links to a derived Google Maps search when only an address is present", () => {
    const { getByRole } = render(() => <MapPreview event={baseEvent} />);
    const link = getByRole("link") as HTMLAnchorElement;
    expect(link.href).toContain("https://www.google.com/maps/search/?api=1&query=");
    expect(link.href).toContain(encodeURIComponent("12 Banksia Lane, Strathfield"));
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("prefers an organiser-supplied mapsUrl", () => {
    const url = "https://maps.apple.com/?address=12+Banksia+Lane";
    const { getByRole } = render(() => <MapPreview event={{ ...baseEvent, mapsUrl: url }} />);
    expect((getByRole("link") as HTMLAnchorElement).href).toBe(url);
  });

  it("shows the venue line on the card", () => {
    const { getByText } = render(() => <MapPreview event={baseEvent} />);
    expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    expect(getByText(/open in maps/i)).toBeTruthy();
  });

  it("renders nothing when there is no address or mapsUrl", () => {
    const { container } = render(() => (
      <MapPreview event={{ ...baseEvent, address: null, mapsUrl: null }} />
    ));
    expect(container.querySelector("a")).toBeNull();
  });

  it("still renders when the address is absent but a mapsUrl is supplied", () => {
    const url = "https://maps.google.com/?q=somewhere";
    const { getByRole, getByText } = render(() => (
      <MapPreview event={{ ...baseEvent, address: null, mapsUrl: url }} />
    ));
    expect((getByRole("link") as HTMLAnchorElement).href).toBe(url);
    // No venue text to show — falls back to a neutral "View on map" label.
    expect(getByText("View on map")).toBeTruthy();
  });

  // T-S1: when there's no venue text to name the link, the accessible name
  // falls back to the generic "Open the venue in maps".
  it("uses an accessible-name fallback when there is no venue but a mapsUrl is present", () => {
    const url = "https://maps.google.com/?q=somewhere";
    const { getByLabelText } = render(() => (
      <MapPreview event={{ ...baseEvent, address: null, mapsUrl: url }} />
    ));
    expect(getByLabelText(/open the venue in maps/i)).toBeTruthy();
  });

  // T-S2: a dangerous organiser-supplied mapsUrl (e.g. javascript:) must never
  // reach the anchor href — the component routes through resolveMapsUrl, which
  // rejects non-http(s) schemes and falls back to the safe Google Maps search
  // URL derived from the address.
  it("never renders a javascript: mapsUrl, falling back to the safe maps search", () => {
    const { getByRole } = render(() => (
      <MapPreview event={{ ...baseEvent, mapsUrl: "javascript:alert(1)" }} />
    ));
    const link = getByRole("link") as HTMLAnchorElement;
    expect(link.href.startsWith("https://www.google.com/maps/search/")).toBe(true);
    expect(link.href).not.toContain("javascript:");
    expect(link.href).toContain(encodeURIComponent("12 Banksia Lane, Strathfield"));
  });

  describe("with PUBLIC_GOOGLE_MAPS_EMBED_KEY configured, third-party content ALLOWED", () => {
    const KEY = "test-embed-key";

    // The iframe hands Google the guest's IP and UA, so it only mounts once the
    // `embeds` category is granted. These tests describe the consented path.
    beforeEach(() => seedConsentForTest({ embeds: true }));

    it("renders a Google Maps Embed iframe keyed on the encoded address", () => {
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);

      const iframe = container.querySelector("iframe");
      expect(iframe).not.toBeNull();
      const src = iframe!.getAttribute("src") ?? "";
      expect(src).toContain("https://www.google.com/maps/embed/v1/place?");
      expect(src).toContain(`key=${encodeURIComponent(KEY)}`);
      expect(src).toContain(`q=${encodeURIComponent("12 Banksia Lane, Strathfield")}`);
    });

    it("gives the iframe an accessible title, lazy loading, and a safe referrerpolicy", () => {
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);

      const iframe = container.querySelector("iframe")!;
      expect(iframe.getAttribute("title")).toBe("Map of 12 Banksia Lane, Strathfield");
      expect(iframe.getAttribute("loading")).toBe("lazy");
      // S-L2: matches the page-level referrer policy so the slug-bearing path
      // is not leaked to Google; only the origin (which the key restriction
      // needs) is sent cross-origin.
      expect(iframe.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
      // S-L1: least-privilege sandbox — no top-navigation / forms.
      const sandbox = iframe.getAttribute("sandbox") ?? "";
      expect(sandbox).toContain("allow-scripts");
      expect(sandbox).toContain("allow-same-origin");
      expect(sandbox).not.toContain("allow-top-navigation");
    });

    it("keeps the 'Open in Maps' link working alongside the iframe", () => {
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { getByRole } = render(() => <MapPreview event={baseEvent} />);

      const link = getByRole("link") as HTMLAnchorElement;
      expect(link.href).toContain("https://www.google.com/maps/search/?api=1&query=");
      expect(link.href).toContain(encodeURIComponent("12 Banksia Lane, Strathfield"));
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    });

    it("falls back to the CSS card (no iframe) when there is no address to query", () => {
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      // mapsUrl present so the component still renders, but no address means
      // there is nothing to feed the Embed API `q` — so no iframe.
      const { container, getByRole } = render(() => (
        <MapPreview
          event={{
            ...baseEvent,
            address: null,
            mapsUrl: "https://maps.google.com/?q=somewhere",
          }}
        />
      ));
      expect(container.querySelector("iframe")).toBeNull();
      expect(getByRole("link")).toBeTruthy();
    });
  });

  describe("with PUBLIC_GOOGLE_MAPS_EMBED_KEY configured, no decision made yet", () => {
    const KEY = "test-embed-key";

    it("DOES render the embed — third-party content is on by default (opt-out)", () => {
      // No consent cookie at all. Under the opt-out defaults the map is part of
      // the invite from the first visit; the banner tells the guest it is on and
      // offers the off switch, rather than asking first.
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);

      expect(container.querySelector("iframe")).not.toBeNull();
    });

    it("still renders nothing when no key is configured", () => {
      // The default only removes the consent condition; the key condition is
      // independent and still gates the iframe.
      const { container } = render(() => <MapPreview event={baseEvent} />);
      expect(container.querySelector("iframe")).toBeNull();
    });
  });

  describe("with PUBLIC_GOOGLE_MAPS_EMBED_KEY configured, third-party content REFUSED", () => {
    const KEY = "test-embed-key";

    beforeEach(() => seedConsentForTest({ embeds: false }));

    it("makes NO request to Google once the guest has switched it off", () => {
      // The refusal has to beat the permissive default. A stored "no" and an
      // absent record must never collapse into the same state.
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);

      expect(container.querySelector("iframe")).toBeNull();
    });

    it("falls back to the CSS map card, not a bare permission notice", () => {
      // The un-consented state has to remain a useful thing to put where a map
      // goes. Refusing costs the guest the interactive tiles and nothing else:
      // the venue is still named and the outbound maps link still works, since
      // a link the guest chooses to follow is their navigation, not our transfer.
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { getByRole, getByText } = render(() => <MapPreview event={baseEvent} />);

      expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
      const link = getByRole("link") as HTMLAnchorElement;
      expect(link.href).toContain("https://www.google.com/maps/search/?api=1&query=");
    });

    it("swaps the CSS card for the live embed on the ALREADY-MOUNTED component", () => {
      // Reactivity, not remount. `seedConsentForTest` resets the store to its
      // pre-hydration state, so asserting against a second `render()` would only
      // prove a fresh mount reads the cookie — a genuine loss of cross-island
      // reactivity would still pass. Granting through the live store is what
      // actually exercises the path the preferences dialog uses.
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);
      expect(container.querySelector("iframe")).toBeNull();

      grantCategory("embeds");

      expect(container.querySelector("iframe")).not.toBeNull();
    });

    it("tears the embed back down when consent is withdrawn from the live store", () => {
      // The withdrawal direction: the standing "Privacy choices" control has to
      // be a real revocation, not just a cookie rewrite.
      seedConsentForTest({ embeds: true });
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);
      expect(container.querySelector("iframe")).not.toBeNull();

      saveConsent({ ...defaultGrants(), embeds: false });

      expect(container.querySelector("iframe")).toBeNull();
    });
  });
});
