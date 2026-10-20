import { render, cleanup } from "@solidjs/testing-library";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { MapPreview } from "../../src/components/MapPreview";
import type { EventSummary } from "../../src/components/types";
import { defaultGrants } from "../../src/lib/consent/record";
import { grantCategory, saveConsent, setReloadPageForTest } from "../../src/lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../test-support/consent";

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

  // An address typed before the venue name existed often starts with the
  // name. Said twice, the row reads it twice, and the calendar entry
  // (`venueLocation`) already drops the repeat.
  it("shows the address alone when it already starts with the venue's name", () => {
    const paragraphs = (venueName: string, address: string) =>
      [
        ...render(() => (
          <MapPreview event={{ ...baseEvent, venueName, address }} />
        )).container.querySelectorAll("p"),
      ].map((p) => p.textContent);

    expect(paragraphs("the grounds", "The Grounds of Alexandria, 7a Huntley St")).toEqual([
      "The Grounds of Alexandria, 7a Huntley St",
    ]);
    cleanup();
    expect(paragraphs("Hall", "Hallstrom Rd, Willoughby")).toEqual([
      "Hall",
      "Hallstrom Rd, Willoughby",
    ]);
  });

  it("prefers an organiser-supplied mapsUrl", () => {
    const url = "https://maps.apple.com/?address=12+Banksia+Lane";
    const { getByRole } = render(() => <MapPreview event={{ ...baseEvent, mapsUrl: url }} />);
    expect((getByRole("link") as HTMLAnchorElement).href).toBe(url);
  });

  it("has one link to the venue in both branches, and the drawn card is not one", () => {
    // The card is decoration — hidden from assistive technology and not a
    // link — so "Open in maps" is the row's one tab stop and one announcement
    // for its destination, with or without the live map above it.
    const card = render(() => <MapPreview event={baseEvent} />);
    expect(card.container.querySelectorAll("a")).toHaveLength(1);
    const drawn = card.container.querySelector('[aria-hidden="true"].h-24');
    expect(drawn, "the drawn card").not.toBeNull();
    expect(drawn!.closest("a")).toBeNull();
    cleanup();

    vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", "test-embed-key");
    seedConsentForTest({ maps: true });
    const embed = render(() => <MapPreview event={baseEvent} />);
    expect(embed.container.querySelector("iframe")).not.toBeNull();
    expect(embed.container.querySelectorAll("a")).toHaveLength(1);
  });

  it("names the link by its visible words, in both branches", () => {
    // Nothing overrides the words the guest sees, so a voice-control user can
    // say them (WCAG 2.5.3); the arrow beside them is decoration.
    const card = render(() => <MapPreview event={baseEvent} />);
    const link = card.getByRole("link", { name: "Open in maps" });
    expect(link.getAttribute("aria-label")).toBeNull();
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toBe("↗");
    cleanup();

    vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", "test-embed-key");
    seedConsentForTest({ maps: true });
    const embed = render(() => <MapPreview event={baseEvent} />);
    expect(embed.getByRole("link", { name: "Open in maps" }).getAttribute("aria-label")).toBeNull();
  });

  it("renders nothing when there is no address or mapsUrl", () => {
    const { container } = render(() => (
      <MapPreview event={{ ...baseEvent, address: null, mapsUrl: null }} />
    ));
    expect(container.querySelector("a")).toBeNull();
  });

  it("still renders when the address is absent but a mapsUrl is supplied", () => {
    // No address to name: the row is the map and the link alone, with no
    // placeholder words standing in for a venue.
    const url = "https://maps.google.com/?q=somewhere";
    const { getByRole, container } = render(() => (
      <MapPreview event={{ ...baseEvent, address: null, mapsUrl: url }} />
    ));
    expect((getByRole("link") as HTMLAnchorElement).href).toBe(url);
    expect(container.querySelector("p")).toBeNull();
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
    // `maps` switch is on. These tests describe the consented path.
    beforeEach(() => seedConsentForTest({ maps: true }));

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

    it("names the map after the venue when it has a name", () => {
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => (
        <MapPreview event={{ ...baseEvent, venueName: "The Glasshouse" }} />
      ));
      expect(container.querySelector("iframe")!.getAttribute("title")).toBe(
        "Map of The Glasshouse",
      );
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

    it("makes NO request to Google before the guest has allowed third-party content", () => {
      // No consent cookie at all. The map loads from Google, which then sees
      // the guest's IP address and browser, so it waits for the guest's yes.
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);

      expect(container.querySelector("iframe")).toBeNull();
    });

    it("shows the CSS map card meanwhile, with the venue and its maps link", () => {
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { getByRole, getByText } = render(() => <MapPreview event={baseEvent} />);

      expect(getByText("12 Banksia Lane, Strathfield")).toBeTruthy();
      const link = getByRole("link") as HTMLAnchorElement;
      expect(link.href).toContain("https://www.google.com/maps/search/?api=1&query=");
    });

    it("renders the embed once the guest has allowed it", () => {
      seedConsentForTest({ maps: true });
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);

      expect(container.querySelector("iframe")).not.toBeNull();
    });

    it("still renders nothing when no key is configured", () => {
      // The key condition is independent of consent and still gates the
      // iframe.
      const { container } = render(() => <MapPreview event={baseEvent} />);
      expect(container.querySelector("iframe")).toBeNull();
    });
  });

  describe("with PUBLIC_GOOGLE_MAPS_EMBED_KEY configured, third-party content REFUSED", () => {
    const KEY = "test-embed-key";

    beforeEach(() => seedConsentForTest({ maps: false }));

    it("makes NO request to Google once the guest has switched it off", () => {
      // A stored "no" holds on every later visit.
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

      grantCategory("maps");

      expect(container.querySelector("iframe")).not.toBeNull();
    });

    it("tears the embed back down when consent is withdrawn from the live store", () => {
      // The withdrawal direction: the standing "Privacy choices" control has to
      // be a real revocation, not just a cookie rewrite.
      seedConsentForTest({ maps: true });
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      const { container } = render(() => <MapPreview event={baseEvent} />);
      expect(container.querySelector("iframe")).not.toBeNull();

      saveConsent({ ...defaultGrants(), maps: false });

      expect(container.querySelector("iframe")).toBeNull();
    });

    it("does not reload the page when consent is withdrawn — the unmount already cleared the map", () => {
      // The map runs only inside its own cross-origin iframe, and removing the
      // iframe destroys everything running in it. A reload would cost a full
      // document load and clear nothing more.
      seedConsentForTest({ maps: true });
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      // After the seed: seeding resets the store, which puts the no-op back.
      const reload = vi.fn();
      setReloadPageForTest(reload);
      const { container } = render(() => <MapPreview event={baseEvent} />);
      expect(container.querySelector("iframe")).not.toBeNull();

      saveConsent({ ...defaultGrants(), maps: false });

      expect(container.querySelector("iframe")).toBeNull();
      expect(reload).not.toHaveBeenCalled();
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
      const line = [...container.querySelectorAll("p")].find(
        (el) => el.textContent === "12 Banksia Lane, Strathfield",
      );
      expect(line, "no element carries the venue address").toBeTruthy();
      return line!.className;
    };

    it("lets the address wrap and bounds it, in the drawn-card branch", () => {
      const { container } = render(() => <MapPreview event={baseEvent} />);
      const classes = addressClasses(container);

      // `truncate` is `white-space: nowrap` + `text-overflow: ellipsis`, which
      // clips at every width rather than only at narrow ones.
      expect(classes).not.toMatch(/(^|\s)truncate(\s|$)/);
      expect(classes).toContain("wrap-anywhere");
      expect(classes).toContain("line-clamp-4");
    });

    it("lets the address wrap and bounds it, in the iframe branch", () => {
      // One address element serves both branches; this is the branch
      // production guests who allowed Google Maps see.
      vi.stubEnv("PUBLIC_GOOGLE_MAPS_EMBED_KEY", KEY);
      seedConsentForTest({ maps: true });
      const { container } = render(() => <MapPreview event={baseEvent} />);
      expect(container.querySelector("iframe")).not.toBeNull();

      const classes = addressClasses(container);
      expect(classes).not.toMatch(/(^|\s)truncate(\s|$)/);
      expect(classes).toContain("wrap-anywhere");
      expect(classes).toContain("line-clamp-4");
    });
  });
});
