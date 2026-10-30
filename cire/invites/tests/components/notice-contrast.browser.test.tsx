import {
  contrastRatio,
  PALETTE_PRESET_KEYS,
  SECTION_TONES,
  sectionToneVars,
  WCAG_TEXT_MIN,
} from "@cire/theme";
import { Notice, type NoticeTone } from "@shared/ui/ui/notice";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import { EventSheet } from "../../src/components/EventSheet";
import { GiftRegistryPage } from "../../src/components/gift-registry/GiftRegistryPage";
import { applyPaletteToRoot } from "../../src/components/invite-theme";
import { LoginSection, type LoginSectionLayout } from "../../src/components/LoginSection";
import type {
  ClaimResult,
  EventSummary,
  FamilyMember,
  RsvpSummary,
} from "../../src/components/types";
import legalLayout from "../../src/layouts/LegalLayout.astro?raw";
import type { GiftRegistryHousehold } from "../../src/lib/gift-registry";
import type { GiftRegistry } from "../../src/lib/gift-registry-read";

/**
 * Notes and gold words on the guest site, held to 4.5:1 in every colour scheme
 * a couple can pick.
 *
 * The RSVP sheet's closed note (`info`) lays the surface at 30% under its
 * muted ink, a backdrop the palette's own pairs never measure, so it is held on
 * every ground a note sits on — the page, the surface and the raised surface.
 *
 * The palette derives its readable gold against each ground alone, so no gold
 * word a guest sees sits on a tint of its own site: the notes and the
 * household's boxes keep their gold rule and draw no fill, a chosen answer or
 * amount keeps its gold border and label and draws no fill, and a legal page's
 * placeholder draws none. Each is measured where it is drawn, on every ground
 * it can get — the welcome's preview note and the household's boxes on each
 * tone an organiser can give the welcome, in both layouts; the RSVP sheet's
 * preview note on the sheet; its chosen answers on each tone the sheet can
 * take; the gift page's notes and chosen amount on each tone the page can
 * take; the closed gift page's link standing alone, its outline pill, under
 * the pointer on each tone the page can take. Inside a site, every element that draws words of its own in the
 * readable gold is measured, and every element between those words and the
 * site's own box must lay no ground, so a gold word added later is held too.
 */

const TONES = ["info"] as const satisfies readonly NoticeTone[];
const GROUNDS = {
  page: "bg-bg",
  surface: "bg-surface",
  "raised surface": "bg-surface-raised",
} as const;
const LAYOUTS = ["band", "panel"] as const satisfies readonly LoginSectionLayout[];

/** Long enough for a lazy chunk's first download in the browser tier. */
const LAZY = { timeout: 5_000 };

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

/** The readable gold, as the document computes it now. */
function goldInk(): string {
  const probe = document.createElement("span");
  probe.className = "text-gold-ink";
  document.body.append(probe);
  const ink = getComputedStyle(probe).color;
  probe.remove();
  return ink;
}

/** Every element in `root`, `root` included, that draws words of its own in the readable gold. */
function goldWords(root: Element): Element[] {
  const ink = goldInk();
  return [root, ...root.querySelectorAll("*")].filter(
    (el) =>
      getComputedStyle(el).color === ink &&
      Array.from(el.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      ),
  );
}

/** Whether `colour` paints nothing, whatever it is laid over. */
function clear(colour: string): boolean {
  return (
    composite(["#000", colour]) === "rgb(0, 0, 0)" &&
    composite(["#fff", colour]) === "rgb(255, 255, 255)"
  );
}

/** Whether `el` lays a ground of its own: a colour that shows, or an image. */
function fills(el: Element): boolean {
  const style = getComputedStyle(el);
  return !clear(style.backgroundColor) || style.backgroundImage !== "none";
}

/** Add to `short` a line when `root` is missing or lays a ground of its own. */
function holdPlain(site: string, root: Element | null | undefined, short: string[]): void {
  if (!root) short.push(`${site}: not drawn`);
  else if (fills(root)) short.push(`${site}: tinted`);
}

/**
 * Add to `short` every gold word in `root` under 4.5:1 or laid on a ground the
 * site draws itself — any element from the word up to `root` that fills — and
 * a line when `root` is missing or holds no gold word, so a site cannot pass by
 * not being drawn. With `rule`, `root` must also keep its 1px border.
 */
function holdGold(
  site: string,
  root: Element | null | undefined,
  short: string[],
  { rule = false } = {},
): void {
  if (!root) {
    short.push(`${site}: not drawn`);
    return;
  }
  const words = goldWords(root);
  if (words.length === 0) short.push(`${site}: no gold words`);
  for (const el of words) {
    const said = `${site}, "${el.textContent?.trim().slice(0, 24)}"`;
    const ratio = wordsRatio(el);
    if (ratio < WCAG_TEXT_MIN) short.push(`${said}: ${ratio.toFixed(2)}`);
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (fills(node)) short.push(`${said}: tinted by <${node.tagName.toLowerCase()}>`);
      if (node === root) break;
    }
  }
  if (rule) {
    const style = getComputedStyle(root);
    const kept =
      style.borderTopWidth === "1px" &&
      style.borderTopStyle === "solid" &&
      !clear(style.borderTopColor);
    if (!kept) short.push(`${site}: no border`);
  }
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

const ada: FamilyMember = {
  guestId: "g-ada",
  firstName: "Ada",
  lastName: "Okafor",
  nickname: null,
  eventIds: ["e-1"],
  plusOneAllowed: true,
};
const ben: FamilyMember = { ...ada, guestId: "g-ben", firstName: "Ben", plusOneAllowed: false };

/**
 * A guest household with every box the welcome draws: Ada may bring a guest,
 * has chosen herself, has no email on file and is linked to the musubi account
 * this browser is signed in to, which has no picture, so its initial shows.
 */
const household: ClaimResult = {
  publicId: "OKAFOR-LILY-AB12CD",
  familyName: "Okafor",
  members: [ada],
  events: [],
  rsvps: [],
  accountLink: {
    enabled: true,
    signedIn: true,
    linkedGuestIds: ["g-ada"],
    account: { displayName: "Ada Okafor", handle: "ada", avatarUrl: null, matchesMember: true },
  },
  member: { guestId: "g-ada" },
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

/** Ada said yes and Ben no, so each of the pair is chosen once. */
const replies: RsvpSummary[] = [
  { guestId: "g-ada", eventId: "e-1", status: "attending", dietary: "" },
  { guestId: "g-ben", eventId: "e-1", status: "declined", dietary: "" },
];

const LIST: GiftRegistry = {
  headline: null,
  message: null,
  cashGiftsEnabled: true,
  currency: "AUD",
  items: [
    {
      id: "i-pan",
      kind: "product",
      title: "Copper pan",
      description: null,
      imageName: null,
      imageCrop: null,
      externalUrl: null,
      priceMinor: 12_000,
      quantityWanted: 2,
      quantityClaimed: 1,
      category: null,
      sortOrder: 0,
    },
  ],
  funds: [
    {
      id: "f-trip",
      title: "Honeymoon",
      description: null,
      imageName: null,
      imageCrop: null,
      sortOrder: 0,
    },
  ],
};

/**
 * The longest name a household can reserve under (`MAX_DISPLAY_NAME_CHARS` in
 * cire-api), as one unbroken word.
 */
const LONG_NAME = "W".repeat(120);

/** The gift page's three households: one that reserved the pan, none, and the organiser's preview. */
const GIFT_STATES = {
  "signed in": {
    claims: [
      { itemId: "i-pan", quantity: 1, status: "reserved", note: null, displayName: LONG_NAME },
    ],
  },
  "signed out": null,
  preview: { claims: [], preview: true },
} as const satisfies Record<string, GiftRegistryHousehold | null>;

const home = window.location.href;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
  window.history.replaceState(null, "", home);
  applyPaletteToRoot(null);
  const root = document.documentElement;
  for (const name of Array.from(root.style)) {
    if (name.startsWith("--")) root.style.removeProperty(name);
  }
});

/**
 * Render the gift page for `state`'s household, back from Stripe, and wait
 * until the parts that state draws are on screen.
 */
async function renderGiftPage(state: keyof typeof GIFT_STATES, themeVars: Record<string, string>) {
  const mine = GIFT_STATES[state];
  if (mine) document.cookie = "cire_claimed=1; Path=/";
  window.history.replaceState(null, "", "?gift=thanks");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const body = String(input).endsWith("/registry/mine") ? mine : LIST;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: body === null ? 401 : 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const view = render(() => (
    <GiftRegistryPage
      apiUrl="https://api.test"
      slug="ada-and-ben"
      inviteHref="/ada-and-ben"
      themeVars={themeVars}
    />
  ));
  const drawn = {
    "signed in": ["[data-gift-mine]", "input[name='gift-amount']:checked"],
    "signed out": ["[data-gift-signed-out]"],
    preview: ["[data-gift-preview]"],
  }[state];
  for (const selector of drawn) {
    await vi.waitFor(() => expect(view.container.querySelector(selector)).not.toBeNull(), LAZY);
  }
  return view;
}

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

  it("holds the household's boxes' gold words to 4.5:1 on every tone, in both layouts", async () => {
    apply();
    const short: string[] = [];
    for (const layout of LAYOUTS) {
      for (const tone of SECTION_TONES) {
        const { unmount } = render(() => (
          <LoginSection
            apiUrl="https://api.test"
            result={household}
            onClaimed={() => {}}
            onMemberChange={() => {}}
            onPlusOneChange={() => {}}
            layout={layout}
            themeVars={sectionToneVars(tone)}
          />
        ));
        const where = `${layout} on ${tone}`;
        const box = async (heading: string) =>
          (await screen.findByText(heading, {}, LAZY)).closest("section");
        const rule = { rule: true };
        holdGold(`${where}, plus-one box`, await box("Bringing a guest"), short, rule);
        holdGold(`${where}, email box`, await box("Wedding emails"), short, rule);
        const link = await box("Link your musubi account");
        holdGold(`${where}, account box`, link, short, rule);
        holdGold(`${where}, account initial`, link && within(link).getByText("A"), short);
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

  it("holds the RSVP sheet's chosen answers to 4.5:1 on every tone", () => {
    apply();
    const short: string[] = [];
    for (const tone of SECTION_TONES) {
      const { unmount } = render(() => (
        <EventSheet
          panel="rsvp"
          siteUrl="https://invite.test/w"
          event={event}
          members={[ada, ben]}
          existingRsvps={replies}
          apiUrl="https://api.test"
          themeVars={sectionToneVars(tone)}
          onClose={() => {}}
        />
      ));
      for (const name of ["Attending", "Not attending"]) {
        const [chosen, other, ...more] = screen
          .getAllByRole("button", { name })
          .filter((button) => button.textContent?.trim() === name)
          .toSorted((a, b) => Number(b.ariaPressed === "true") - Number(a.ariaPressed === "true"));
        if (other?.ariaPressed !== "false" || more.length > 0) {
          short.push(`${tone}: not one chosen and one other "${name}"`);
        }
        holdGold(`${tone}, chosen "${name}"`, chosen, short);
        // Gold marks the chosen answer only.
        if (other && goldWords(other).length > 0) short.push(`${tone}, other "${name}": gold`);
      }
      unmount();
    }
    expect(short).toEqual([]);
  });

  it("holds the gift page's notes and chosen gift to 4.5:1 on every tone", async () => {
    apply();
    const short: string[] = [];
    const rule = { rule: true };
    for (const tone of SECTION_TONES) {
      const themeVars = sectionToneVars(tone);

      const signedIn = await renderGiftPage("signed in", themeVars);
      const page = signedIn.container;
      holdGold(`${tone}, payment note`, page.querySelector("[data-gift-payment]"), short, rule);
      const mine = page.querySelector("[data-gift-mine]");
      holdGold(`${tone}, "You reserved"`, mine, short, rule);
      // The card skips laying out what is off screen, so bring the note in
      // before reading its width.
      mine?.scrollIntoView();
      if (!mine || mine.clientWidth === 0 || mine.scrollWidth > mine.clientWidth) {
        short.push(`${tone}, "You reserved": runs out of its box`);
      }
      holdGold(
        `${tone}, chosen amount`,
        page.querySelector("input[name='gift-amount']:checked")?.closest("label"),
        short,
      );
      for (const input of page.querySelectorAll("input[name='gift-amount']:not(:checked)")) {
        const label = input.closest("label");
        if (!label || goldWords(label).length > 0) {
          short.push(`${tone}, other amount "${label?.textContent?.trim()}": gold`);
        }
      }
      holdPlain(
        `${tone}, chosen fund`,
        page.querySelector("input[name='gift-fund']:checked")?.closest("label"),
        short,
      );
      signedIn.unmount();
      cleanup();
      vi.unstubAllGlobals();
      document.cookie = "cire_claimed=; Path=/; Max-Age=0";

      const signedOut = await renderGiftPage("signed out", themeVars);
      holdGold(
        `${tone}, signed-out note`,
        signedOut.container.querySelector("[data-gift-signed-out]"),
        short,
        rule,
      );
      signedOut.unmount();
      cleanup();
      vi.unstubAllGlobals();

      const organiser = await renderGiftPage("preview", themeVars);
      holdGold(
        `${tone}, preview note`,
        organiser.container.querySelector("[data-gift-preview]"),
        short,
        rule,
      );
      organiser.unmount();
      cleanup();
      vi.unstubAllGlobals();
      document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    }
    expect(short).toEqual([]);
  });

  it("holds the closed gift page's link pill to 4.5:1 under the pointer, with no fill, on every tone", async () => {
    // "Back to the invitation", a link standing alone: `outline` answers the
    // pointer with its edge alone, so its gold word stays on the ground the
    // palette derived it against, and it keeps the 44px touch floor.
    apply();
    const short: string[] = [];
    for (const tone of SECTION_TONES) {
      // A 404 is the API's one answer for a list the guest cannot see.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response("{}", { status: 404 }))),
      );
      const view = render(() => (
        <GiftRegistryPage
          apiUrl="https://api.test"
          slug="ada-and-ben"
          inviteHref="/ada-and-ben"
          themeVars={sectionToneVars(tone)}
        />
      ));
      const pill = await screen.findByRole("link", { name: "Back to the invitation" }, LAZY);
      await userEvent.hover(pill);
      await Promise.all(pill.getAnimations().map((a) => a.finished));
      if (fills(pill)) short.push(`${tone}: fills under the pointer`);
      const ratio = wordsRatio(pill);
      if (ratio < WCAG_TEXT_MIN) short.push(`${tone}: ${ratio.toFixed(2)}:1`);
      if (pill.getBoundingClientRect().height < 44) short.push(`${tone}: under 44px`);
      view.unmount();
      cleanup();
      vi.unstubAllGlobals();
    }
    expect(short).toEqual([]);
  });

  it("holds a legal page's placeholder to 4.5:1 on the page", () => {
    apply();
    // The legal pages style themselves in `LegalLayout.astro`'s global block,
    // which no component renders, so the block is laid on the document as is.
    const css = /<style is:global>([\s\S]*?)<\/style>/.exec(legalLayout)?.[1];
    expect(css).toBeTruthy();
    const style = document.createElement("style");
    style.textContent = css!;
    // Built by hand: the page's own class names are not Tailwind's.
    const legal = document.createElement("main");
    legal.className = "legal";
    const line = legal.appendChild(document.createElement("p"));
    line.append("Write to us at ");
    const placeholder = line.appendChild(document.createElement("span"));
    placeholder.className = "placeholder";
    placeholder.textContent = "{{POSTAL_ADDRESS}}";
    document.head.append(style);
    document.body.append(legal);
    try {
      const short: string[] = [];
      holdGold("placeholder", placeholder, short);
      expect(short).toEqual([]);
    } finally {
      legal.remove();
      style.remove();
    }
  });
});
