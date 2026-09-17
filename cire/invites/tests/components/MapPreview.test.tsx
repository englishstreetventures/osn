import { render, cleanup } from "@solidjs/testing-library";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { MapPreview } from "../../src/components/MapPreview";
import type { EventSummary } from "../../src/components/types";
import { defaultGrants } from "../../src/lib/consent/record";
import { grantCategory, saveConsent } from "../../src/lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../../src/lib/consent/testing";

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

  it("keeps the card's affordance a decoration on one link, not a second link", () => {
    // The whole card is the anchor, so the action is a `<span>` inside it: the
    // visible signal that the card is clickable. Two anchors here would be two
    // tab stops and two announcements for one destination — the distinction
    // between the two branches that is easiest to flatten by accident.
    const { container, getByText } = render(() => <MapPreview event={baseEvent} />);

    expect(container.querySelectorAll("a")).toHaveLength(1);
    const label = getByText(/open in maps/i);
    expect(label.closest("a")).toBe(container.querySelector("a"));
    // The label's own box is the `sr-only` span; the action that holds it is
    // the element that must not be a link.
    expect(label.parentElement?.tagName).toBe("SPAN");
  });

  it("names the action 'Open in Maps' in words in both branches, though it draws a glyph", () => {
    // What the icon could silently take away. The words move into a clipped
    // span rather than out of the document, so nothing an assistive technology
    // reads is lost by drawing a glyph instead.
    const card = render(() => <MapPreview event={baseEvent} />);
    const cardLabel = card.getByText("Open in Maps");
    expect(cardLabel.className).toContain("sr-only");
    // The card itself is the link here, and it is the venue it names.
    expect((card.getByRole("link") as HTMLAnchorElement).getAttribute("aria-label")).toBe(
      "Open 12 Banksia Lane, Strathfield in maps",
    );
    cleanup();

    vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", "test-embed-key");
    const embed = render(() => <MapPreview event={baseEvent} />);
    const embedLabel = embed.getByText("Open in Maps");
    expect(embedLabel.className).toContain("sr-only");
    // Here the action is itself the link, and it carries the same name the
    // card's does — the venue, which is more than the clipped words say.
    expect((embed.getByRole("link") as HTMLAnchorElement).getAttribute("aria-label")).toBe(
      "Open 12 Banksia Lane, Strathfield in maps",
    );
  });

  it("hides the glyph from assistive technology in both branches", () => {
    // The glyph is decoration that stands in for the words beside it. Announced,
    // it would be a second, wordless copy of the same action.
    const { container } = render(() => <MapPreview event={baseEvent} />);
    const label = container.querySelector(".sr-only") as HTMLElement;
    const glyph = label.parentElement?.querySelector("svg");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
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

  // When there's no venue text to name the link, the accessible name
  // falls back to the generic "Open the venue in maps".
  it("uses an accessible-name fallback when there is no venue but a mapsUrl is present", () => {
    const url = "https://maps.google.com/?q=somewhere";
    const { getByLabelText } = render(() => (
      <MapPreview event={{ ...baseEvent, address: null, mapsUrl: url }} />
    ));
    expect(getByLabelText(/open the venue in maps/i)).toBeTruthy();
  });

  // A dangerous organiser-supplied mapsUrl (e.g. javascript:) must never
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
      // Matches the page-level referrer policy so the slug-bearing path
      // is not leaked to Google; only the origin (which the key restriction
      // needs) is sent cross-origin.
      expect(iframe.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
      // Least-privilege sandbox — no top-navigation / forms.
      const sandbox = iframe.getAttribute("sandbox") ?? "";
      expect(sandbox).toContain("allow-scripts");
      expect(sandbox).toContain("allow-same-origin");
      expect(sandbox).not.toContain("allow-top-navigation");
    });

    it("keeps a real maps link beside the iframe, on the organiser's own destination", () => {
      // Not a duplicate of Google's in-frame "View larger map": that opens a
      // place query for the address, while this follows `resolveMapsUrl`, which
      // prefers whatever the organiser pinned.
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container, getByRole, getByText } = render(() => <MapPreview event={baseEvent} />);

      expect(container.querySelector("iframe")).not.toBeNull();
      const link = getByRole("link") as HTMLAnchorElement;
      expect(link.href).toContain("https://www.google.com/maps/search/?api=1&query=");
      expect(link.href).toContain(encodeURIComponent("12 Banksia Lane, Strathfield"));
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
      expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
    });

    it("prefers the organiser's mapsUrl for the footer link beside the iframe", () => {
      // The reason the link survives at all: the two destinations differ here,
      // and this is the only one that reaches the organiser's own pin.
      const url = "https://maps.apple.com/?address=12+Banksia+Lane";
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container, getByRole } = render(() => (
        <MapPreview event={{ ...baseEvent, mapsUrl: url }} />
      ));

      expect(container.querySelector("iframe")).not.toBeNull();
      expect((getByRole("link") as HTMLAnchorElement).href).toBe(url);
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

  /**
   * The mechanism half of the address's wrapping contract. The outcome half —
   * that the address is genuinely readable and genuinely unclipped at a given
   * width — is in `MapPreview.browser.test.tsx`, because jsdom parses no
   * stylesheet and computes no layout, so `getByText` finds the address whether
   * it is painted in full or cut off at the first word.
   *
   * What this adds that the browser tier cannot: it names the utilities, so a
   * regression reads as "someone put `truncate` back" rather than as an
   * arithmetic failure on a rect.
   */
  describe("the venue line's wrapping contract", () => {
    const KEY = "test-embed-key";

    const addressClasses = (container: HTMLElement) => {
      const line = [...container.querySelectorAll("span")].find(
        (el) => el.textContent === "12 Banksia Lane, Strathfield",
      );
      expect(line, "no element carries the venue address").toBeTruthy();
      return line!.className;
    };

    it("lets the address wrap and bounds it, in the CSS-card branch", () => {
      const { container } = render(() => <MapPreview event={baseEvent} />);
      const classes = addressClasses(container);

      // `truncate` is `white-space: nowrap` + `text-overflow: ellipsis`, which
      // clips at every width rather than only at narrow ones.
      expect(classes).not.toMatch(/(^|\s)truncate(\s|$)/);
      expect(classes).toContain("wrap-anywhere");
      expect(classes).toContain("line-clamp-3");
      // The action is what the address shares its row with, so the address must
      // still be allowed to shrink inside the flex row.
      expect(classes).toContain("min-w-0");
      expect(classes).toContain("flex-1");
    });

    it("lets the address wrap and bounds it, in the iframe branch", () => {
      // The footer is shared, so both branches inherit one contract — but the
      // iframe branch is the one production guests see, and it would be the one
      // to silently diverge if the footer were ever forked per branch.
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      seedConsentForTest({ embeds: true });
      const { container } = render(() => <MapPreview event={baseEvent} />);
      expect(container.querySelector("iframe")).not.toBeNull();

      const classes = addressClasses(container);
      expect(classes).not.toMatch(/(^|\s)truncate(\s|$)/);
      expect(classes).toContain("wrap-anywhere");
      expect(classes).toContain("line-clamp-3");
    });
  });
});
