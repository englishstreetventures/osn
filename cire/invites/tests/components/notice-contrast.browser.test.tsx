import {
  contrastRatio,
  PALETTE_PRESET_KEYS,
  SECTION_TONES,
  sectionToneVars,
  WCAG_TEXT_MIN,
} from "@cire/theme";
import { Notice, type NoticeTone } from "@shared/ui/ui/notice";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../src/styles/global.css";
import { EventSheet } from "../../src/components/EventSheet";
import { GiftRegistryPage } from "../../src/components/gift-registry/GiftRegistryPage";
import { applyPaletteToRoot } from "../../src/components/invite-theme";
import { LoginSection, type LoginSectionLayout } from "../../src/components/LoginSection";
import type { ClaimResult, EventSummary } from "../../src/components/types";
import type { GiftRegistry } from "../../src/lib/gift-registry-read";

/**
 * Notes on the guest site, their words held to 4.5:1 in every colour scheme a
 * couple can pick.
 *
 * The RSVP sheet's closed note (`info`) lays the surface at 30% under its
 * muted ink, a backdrop the palette's own pairs never measure, so it is held on
 * every ground a note sits on — the page, the surface and the raised surface.
 *
 * The preview notes an organiser sees — the welcome's, the RSVP sheet's and the
 * gift page's — draw no tint, so their readable gold sits on the ground
 * beneath. Each is measured where it is drawn, on every ground it can get: the
 * welcome on each tone an organiser can give it, in both layouts; the RSVP
 * sheet's on the sheet; the gift page's on the page.
 */

const TONES = ["info"] as const satisfies readonly NoticeTone[];
const GROUNDS = {
  page: "bg-bg",
  surface: "bg-surface",
  "raised surface": "bg-surface-raised",
} as const;
const LAYOUTS = ["band", "panel"] as const satisfies readonly LoginSectionLayout[];

/** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The contrast of `el`'s words against what is painted under them: the page,
 * then every ancestor's background down to `el`'s own, translucent ones
 * included.
 */
function wordsRatio(el: Element): number {
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  const page = getComputedStyle(document.documentElement).getPropertyValue("--color-bg");
  const under = composite([page, ...layers]);
  return contrastRatio(composite([under, getComputedStyle(el).color]), under)!;
}

/** The `Notice` inside the status region that holds `words`. */
function noticeHolding(words: RegExp): Element {
  const region = screen.getByText(words).closest("[role='status']");
  const box = region?.firstElementChild;
  if (!box) throw new Error(`no status region holds ${words}`);
  return box;
}

const preview: ClaimResult = {
  publicId: "PREVIEW-HOST-AB12",
  familyName: "Okafor",
  preview: true,
  members: [
    { guestId: "g-ada", firstName: "Ada", lastName: "Okafor", nickname: null, eventIds: ["e-1"] },
  ],
  events: [],
  rsvps: [],
};

const event: EventSummary = {
  id: "e-1",
  name: "Ceremony",
  description: "Vows on the lawn",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T18:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const LIST: GiftRegistry = {
  headline: null,
  message: null,
  cashGiftsEnabled: false,
  currency: "AUD",
  items: [],
  funds: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
  applyPaletteToRoot(null);
  const root = document.documentElement;
  for (const name of Array.from(root.style)) {
    if (name.startsWith("--")) root.style.removeProperty(name);
  }
});

describe.each(PALETTE_PRESET_KEYS)("the %s scheme", (palettePreset) => {
  const apply = () => applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });

  it("holds the closed note's words to 4.5:1 on every ground", () => {
    apply();
    const short: string[] = [];
    for (const [groundName, ground] of Object.entries(GROUNDS)) {
      for (const tone of TONES) {
        const { container, unmount } = render(() => (
          <div class={ground}>
            <Notice size="sm" tone={tone}>
              RSVPs have closed.
            </Notice>
          </div>
        ));
        const ratio = wordsRatio(container.firstElementChild!.firstElementChild!);
        if (ratio < WCAG_TEXT_MIN) short.push(`${tone} on the ${groundName}: ${ratio.toFixed(2)}`);
        unmount();
      }
    }
    expect(short).toEqual([]);
  });

  it("holds the welcome's preview note to 4.5:1 on every tone, in both layouts", () => {
    apply();
    const short: string[] = [];
    for (const layout of LAYOUTS) {
      for (const tone of SECTION_TONES) {
        const { unmount } = render(() => (
          <LoginSection
            apiUrl="https://api.test"
            result={preview}
            onClaimed={() => {}}
            layout={layout}
            themeVars={sectionToneVars(tone)}
          />
        ));
        const ratio = wordsRatio(noticeHolding(/^Preview mode\. Every event is shown/));
        if (ratio < WCAG_TEXT_MIN) short.push(`${layout} on ${tone}: ${ratio.toFixed(2)}`);
        unmount();
      }
    }
    expect(short).toEqual([]);
  });

  it("holds the RSVP sheet's preview note to 4.5:1 on the sheet", () => {
    apply();
    render(() => (
      <EventSheet
        panel="rsvp"
        siteUrl="https://invite.test/w"
        event={event}
        members={preview.members}
        apiUrl="https://api.test"
        preview
        onClose={() => {}}
      />
    ));
    const ratio = wordsRatio(noticeHolding(/Nothing you send here is saved/));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
  });

  it("holds the gift page's preview note to 4.5:1 on the page", async () => {
    apply();
    document.cookie = "cire_claimed=1; Path=/";
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const body = String(input).endsWith("/registry/mine")
          ? { claims: [], preview: true }
          : LIST;
        return Promise.resolve(
          new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
        );
      }),
    );
    const { container } = render(() => (
      <GiftRegistryPage apiUrl="https://api.test" slug="ada-and-ben" inviteHref="/ada-and-ben" />
    ));
    await vi.waitFor(() => expect(container.querySelector("[data-gift-preview]")).not.toBeNull());
    const ratio = wordsRatio(container.querySelector("[data-gift-preview]")!);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
  });
});
