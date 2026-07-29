import { families, weddingInviteCustomisations, weddings } from "@cire/db";
import type {
  FontStyleChoice,
  FontWeightChoice,
  HeadingSizeChoice,
  PalettePresetKey,
  SectionTone,
} from "@cire/theme";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricInviteAssetUploaded, metricInviteSaved } from "../metrics";
import {
  decodeCrop,
  HERO_BLUR_DEFAULT,
  type CropScreen,
  type FontChoice,
  type ImageCrop,
  type InviteImageSlot,
  type InviteTextBody,
  type InviteThemeBody,
} from "../schemas/invite";
import { deleteAsset, storeAsset } from "./invite-assets";
import type { AssetR2Error, AssetsR2Service } from "./invite-assets";

export class WeddingNotFound extends Data.TaggedError("WeddingNotFound")<{
  readonly slug?: string;
}> {}

/**
 * The customisation as the invite renders it. Text fields are the raw stored
 * overrides (`null` ⇒ the guest site / organiser preview falls back to the
 * built-in default copy). Image fields are ready-to-use URL *paths* — clients
 * prepend their API origin — carrying a `?v=` cache-buster keyed to the row's
 * `updatedAt` so a re-uploaded image isn't served stale.
 */
/**
 * Per-section theme as the invite renders it. Every field is nullable; `null`
 * means "use the built-in default token", so an un-themed invite renders exactly
 * as before. Fonts are bounded enum keys (the guest site maps them to a concrete
 * font-family stack); colours have already passed the server-side allow-list on
 * write, so the guest site can interpolate them into CSS variables safely (it
 * still re-validates defensively).
 */
export interface InviteTheme {
  headingFont: FontChoice | null;
  bodyFont: FontChoice | null;
  /**
   * Global typography options (migration 0048) — heading size/weight/style +
   * body weight/style. Closed enum keys; the guest site resolves each to a
   * fixed CSS value in `@cire/theme` (`null` / unknown ⇒ the pack's built-in
   * look).
   */
  headingSize: HeadingSizeChoice | null;
  headingWeight: FontWeightChoice | null;
  headingStyle: FontStyleChoice | null;
  bodyWeight: FontWeightChoice | null;
  bodyStyle: FontStyleChoice | null;
  /** Which curated scheme the organiser started from (presentation only). */
  palettePreset: PalettePresetKey | null;
  /**
   * The five colour seeds. Every other colour on the invite is derived from
   * these by `derivePalette` in `@cire/theme`; a `null` seed falls back to that
   * role's value in the default preset, so a partly-filled scheme is always
   * renderable and an un-themed invite looks exactly as it always has.
   */
  palette: {
    ground: string | null;
    card: string | null;
    ink: string | null;
    gilt: string | null;
    bloom: string | null;
  };
  /** Which derived surface each section sits on (`null` ⇒ the page ground). */
  tones: {
    hero: SectionTone | null;
    story: SectionTone | null;
    details: SectionTone | null;
    welcome: SectionTone | null;
  };
}

/**
 * Hero display sliders the organiser picked (migration 0018 replaced the coarse
 * enums). Always concrete (never null) — the DB columns are NOT NULL with
 * defaults that reproduce today's look, so an un-customised wedding reports
 * `{ blur: 28, titleBackdrop: { opacity: 0, blur: 0 } }` and the guest site
 * renders exactly as before.
 *
 *  - `blur` (0–40) — the hero backdrop's server-side Gaussian blur radius.
 *  - `titleBackdrop.opacity` (0–100) — opacity (÷100) of the legibility panel
 *    behind the hero title.
 *  - `titleBackdrop.blur` (0–20) — frosted-glass blur in px behind the title.
 */
export interface HeroDisplay {
  blur: number;
  titleBackdrop: { opacity: number; blur: number };
}

export interface InviteCustomisation {
  hero: {
    title: string | null;
    subtitle: string | null;
    imageUrl: string | null;
    // Normalised crop rectangle `{x,y,w,h}` (0..1 source fractions) the guest
    // site applies in CSS, or null for the default centre `object-cover`.
    imageCrop: ImageCrop | null;
    // Phone-specific hero crop (migration 0046) — applied by the guest site
    // below its desktop breakpoint. Null ⇒ narrow viewports fall back to
    // `imageCrop` (today's behaviour). Hero-only: the other images render at a
    // single aspect and keep one rectangle.
    imageCropMobile: ImageCrop | null;
  };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
    imageCrop: ImageCrop | null;
  };
  // Events ("details") section header copy (migration 0028). `null` ⇒ the guest
  // site's built-in "Celebrate With Us" / "Your Events" defaults.
  details: {
    eyebrow: string | null;
    heading: string | null;
  };
  // Post-claim welcome greeting (migration 0028). `null` ⇒ the built-in
  // "We are delighted to invite you to celebrate with us." default.
  welcome: {
    message: string | null;
  };
  // Footer closing note (0049) + its optional image (0050) — a small centred
  // monogram / motif / signature above the note. Both `null` ⇒ the guest site
  // renders NEITHER; there is no built-in default here, unlike
  // `details` / `welcome`, and the two are independent (either alone is valid).
  footer: {
    message: string | null;
    imageUrl: string | null;
    imageCrop: ImageCrop | null;
  };
  heroDisplay: HeroDisplay;
  theme: InviteTheme;
  // Optional host override for the first line of the copyable invite message
  // (migration 0023). `null` ⇒ the organiser falls back to the built-in default
  // prose. Surfaced on the organiser GET only (the guest site never reads it).
  inviteMessage: string | null;
  // Which design pack the invite renders as (0045). Always concrete — a
  // missing row or a pre-0045 null reads as "classic".
  designId: string;
}

const EMPTY_THEME: InviteTheme = {
  headingFont: null,
  bodyFont: null,
  headingSize: null,
  headingWeight: null,
  headingStyle: null,
  bodyWeight: null,
  bodyStyle: null,
  palettePreset: null,
  palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
  tones: { hero: null, story: null, details: null, welcome: null },
};

// The defaults a wedding with no customisation row reports — identical to the
// NOT-NULL column defaults (0018), so a missing row and a default row render the
// same. `blur: 28` reproduces the former fixed `VARIANT_BLUR["hero-bg"]` look.
const DEFAULT_HERO_DISPLAY: HeroDisplay = {
  blur: HERO_BLUR_DEFAULT,
  titleBackdrop: { opacity: 0, blur: 0 },
};

const EMPTY: InviteCustomisation = {
  hero: { title: null, subtitle: null, imageUrl: null, imageCrop: null, imageCropMobile: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null, imageCrop: null },
  details: { eyebrow: null, heading: null },
  welcome: { message: null },
  footer: { message: null, imageUrl: null, imageCrop: null },
  heroDisplay: DEFAULT_HERO_DISPLAY,
  theme: EMPTY_THEME,
  inviteMessage: null,
  designId: "classic",
};

/** Public path the invite image is served from. Clients prepend the API origin. */
function imagePath(slug: string, slot: InviteImageSlot, version: number): string {
  return `/api/invite/${encodeURIComponent(slug)}/image/${slot}?v=${version}`;
}

/**
 * Which columns back each image slot. This is the ONE place the slot union maps
 * onto storage — every read/write below indexes this table rather than branching
 * on the slot name. That matters: while there were exactly two slots the code
 * branched `slot === "hero" ? … : …` everywhere, and adding a third (`footer`,
 * migration 0050) would have silently made every one of those branches treat it
 * as the story slot — writing the footer's image into `story_image_key`.
 *
 * `cropMobile` is hero-only (migration 0046): the hero is the one full-bleed
 * image rendered at both wide and tall viewport aspects, so it carries a second
 * rectangle. `null` for every other slot, whose single aspect needs one.
 */
const SLOT_COLUMNS = {
  hero: {
    key: "heroImageKey",
    crop: "heroImageCrop",
    cropMobile: "heroImageCropMobile",
  },
  story: { key: "storyImageKey", crop: "storyImageCrop", cropMobile: null },
  footer: { key: "footerImageKey", crop: "footerImageCrop", cropMobile: null },
} as const satisfies Record<
  InviteImageSlot,
  { key: string; crop: string; cropMobile: string | null }
>;

/**
 * The crop column(s) to null out when a slot's image is replaced or removed — a
 * fresh image invalidates the previous rectangle (it framed a different photo),
 * so the slot starts full-frame again. For the hero that means BOTH rectangles.
 */
function cropResetsFor(slot: InviteImageSlot): Record<string, null> {
  const cols = SLOT_COLUMNS[slot];
  return cols.cropMobile ? { [cols.crop]: null, [cols.cropMobile]: null } : { [cols.crop]: null };
}

/** Trim, then collapse an all-whitespace/empty override to `null` (use default). */
function normaliseCopy(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Map a (possibly absent, via LEFT JOIN) customisation row + slug to the response. */
function toCustomisation(
  slug: string,
  c: {
    heroTitle: string | null;
    heroSubtitle: string | null;
    storyEyebrow: string | null;
    storyHeading: string | null;
    storyBody: string | null;
    detailsEyebrow: string | null;
    detailsHeading: string | null;
    welcomeMessage: string | null;
    footerMessage: string | null;
    heroImageKey: string | null;
    storyImageKey: string | null;
    footerImageKey: string | null;
    heroImageCrop: string | null;
    heroImageCropMobile: string | null;
    storyImageCrop: string | null;
    footerImageCrop: string | null;
    // NOT NULL columns, but a LEFT JOIN miss (no customisation row) yields null —
    // coalesced to the today's-look default below.
    heroBlur: number | null;
    heroTitleBackdropOpacity: number | null;
    heroTitleBackdropBlur: number | null;
    themeHeadingFont: string | null;
    themeBodyFont: string | null;
    themeHeadingSize: string | null;
    themeHeadingWeight: string | null;
    themeHeadingStyle: string | null;
    themeBodyWeight: string | null;
    themeBodyStyle: string | null;
    palettePreset: string | null;
    paletteGround: string | null;
    paletteCard: string | null;
    paletteInk: string | null;
    paletteGilt: string | null;
    paletteBloom: string | null;
    heroTone: string | null;
    storyTone: string | null;
    detailsTone: string | null;
    welcomeTone: string | null;
    inviteMessage: string | null;
    // NOT NULL column, but a LEFT JOIN miss (no customisation row) yields null.
    designId: string | null;
    updatedAt: Date | null;
    imagesUpdatedAt: Date | null;
  },
): InviteCustomisation {
  // The image URLs' ?v= cache-buster tracks the IMAGE version, not the row
  // version — a copy/colour save must not bust the guest image caches
  // (WT-P-I1). `imagesUpdatedAt` is null only for rows that predate any image
  // write; coalesce to `updatedAt` as a safety net.
  const imageVersion = c.imagesUpdatedAt ?? c.updatedAt;
  const version = imageVersion ? imageVersion.getTime() : 0;
  return {
    hero: {
      title: c.heroTitle,
      subtitle: c.heroSubtitle,
      imageUrl: c.heroImageKey ? imagePath(slug, "hero", version) : null,
      // Only surface a crop when there's an image to crop — a stored rectangle on
      // a since-removed image is inert. `decodeCrop` drops a malformed/legacy
      // value to null so a bad rectangle never reaches the guest-facing style.
      imageCrop: c.heroImageKey ? decodeCrop(c.heroImageCrop) : null,
      imageCropMobile: c.heroImageKey ? decodeCrop(c.heroImageCropMobile) : null,
    },
    story: {
      eyebrow: c.storyEyebrow,
      heading: c.storyHeading,
      body: c.storyBody,
      imageUrl: c.storyImageKey ? imagePath(slug, "story", version) : null,
      imageCrop: c.storyImageKey ? decodeCrop(c.storyImageCrop) : null,
    },
    details: { eyebrow: c.detailsEyebrow, heading: c.detailsHeading },
    welcome: { message: c.welcomeMessage },
    footer: {
      message: c.footerMessage,
      imageUrl: c.footerImageKey ? imagePath(slug, "footer", version) : null,
      imageCrop: c.footerImageKey ? decodeCrop(c.footerImageCrop) : null,
    },
    heroDisplay: {
      // Persisted values already passed the clamp-on-write validation; a null
      // (no row / LEFT JOIN miss) falls back to the today's-look default so an
      // un-customised invite is unchanged.
      blur: c.heroBlur ?? DEFAULT_HERO_DISPLAY.blur,
      titleBackdrop: {
        opacity: c.heroTitleBackdropOpacity ?? DEFAULT_HERO_DISPLAY.titleBackdrop.opacity,
        blur: c.heroTitleBackdropBlur ?? DEFAULT_HERO_DISPLAY.titleBackdrop.blur,
      },
    },
    theme: {
      // Persisted theme fonts/colours already passed validation on write; the
      // font is a bounded enum key, the colour an allow-listed CSS string.
      headingFont: c.themeHeadingFont as FontChoice | null,
      bodyFont: c.themeBodyFont as FontChoice | null,
      headingSize: c.themeHeadingSize as HeadingSizeChoice | null,
      headingWeight: c.themeHeadingWeight as FontWeightChoice | null,
      headingStyle: c.themeHeadingStyle as FontStyleChoice | null,
      bodyWeight: c.themeBodyWeight as FontWeightChoice | null,
      bodyStyle: c.themeBodyStyle as FontStyleChoice | null,
      palettePreset: c.palettePreset as PalettePresetKey | null,
      palette: {
        ground: c.paletteGround,
        card: c.paletteCard,
        ink: c.paletteInk,
        gilt: c.paletteGilt,
        bloom: c.paletteBloom,
      },
      tones: {
        hero: c.heroTone as SectionTone | null,
        story: c.storyTone as SectionTone | null,
        details: c.detailsTone as SectionTone | null,
        welcome: c.welcomeTone as SectionTone | null,
      },
    },
    inviteMessage: c.inviteMessage,
    designId: c.designId ?? "classic",
  };
}

export const inviteService = {
  /** Customisation for an organiser-owned wedding (weddingId already authorised). */
  getForWedding(
    weddingId: string,
    slug: string,
  ): Effect.Effect<InviteCustomisation, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select()
          .from(weddingInviteCustomisations)
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .all(),
      );
      return row ? toCustomisation(slug, row) : EMPTY;
    }).pipe(Effect.withSpan("cire.invite.getForWedding"));
  },

  /** Slug for an organiser-owned wedding (weddingOwner already proved it exists). */
  weddingSlug(weddingId: string): Effect.Effect<string, WeddingNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db.select({ slug: weddings.slug }).from(weddings).where(eq(weddings.id, weddingId)).all(),
      );
      if (!row) return yield* Effect.fail(new WeddingNotFound({}));
      return row.slug;
    });
  },

  /**
   * Customisation for an owned wedding (organiser GET). Single LEFT JOIN so the
   * slug + customisation come back in one round-trip (IB-P-W3).
   */
  getForWeddingId(
    weddingId: string,
  ): Effect.Effect<InviteCustomisation, WeddingNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select({
            slug: weddings.slug,
            heroTitle: weddingInviteCustomisations.heroTitle,
            heroSubtitle: weddingInviteCustomisations.heroSubtitle,
            storyEyebrow: weddingInviteCustomisations.storyEyebrow,
            storyHeading: weddingInviteCustomisations.storyHeading,
            storyBody: weddingInviteCustomisations.storyBody,
            detailsEyebrow: weddingInviteCustomisations.detailsEyebrow,
            detailsHeading: weddingInviteCustomisations.detailsHeading,
            welcomeMessage: weddingInviteCustomisations.welcomeMessage,
            footerMessage: weddingInviteCustomisations.footerMessage,
            heroImageKey: weddingInviteCustomisations.heroImageKey,
            storyImageKey: weddingInviteCustomisations.storyImageKey,
            footerImageKey: weddingInviteCustomisations.footerImageKey,
            heroImageCrop: weddingInviteCustomisations.heroImageCrop,
            heroImageCropMobile: weddingInviteCustomisations.heroImageCropMobile,
            storyImageCrop: weddingInviteCustomisations.storyImageCrop,
            footerImageCrop: weddingInviteCustomisations.footerImageCrop,
            heroBlur: weddingInviteCustomisations.heroBlur,
            heroTitleBackdropOpacity: weddingInviteCustomisations.heroTitleBackdropOpacity,
            heroTitleBackdropBlur: weddingInviteCustomisations.heroTitleBackdropBlur,
            themeHeadingFont: weddingInviteCustomisations.themeHeadingFont,
            themeBodyFont: weddingInviteCustomisations.themeBodyFont,
            themeHeadingSize: weddingInviteCustomisations.themeHeadingSize,
            themeHeadingWeight: weddingInviteCustomisations.themeHeadingWeight,
            themeHeadingStyle: weddingInviteCustomisations.themeHeadingStyle,
            themeBodyWeight: weddingInviteCustomisations.themeBodyWeight,
            themeBodyStyle: weddingInviteCustomisations.themeBodyStyle,
            palettePreset: weddingInviteCustomisations.palettePreset,
            paletteGround: weddingInviteCustomisations.paletteGround,
            paletteCard: weddingInviteCustomisations.paletteCard,
            paletteInk: weddingInviteCustomisations.paletteInk,
            paletteGilt: weddingInviteCustomisations.paletteGilt,
            paletteBloom: weddingInviteCustomisations.paletteBloom,
            heroTone: weddingInviteCustomisations.heroTone,
            storyTone: weddingInviteCustomisations.storyTone,
            detailsTone: weddingInviteCustomisations.detailsTone,
            welcomeTone: weddingInviteCustomisations.welcomeTone,
            inviteMessage: weddingInviteCustomisations.inviteMessage,
            designId: weddingInviteCustomisations.designId,
            updatedAt: weddingInviteCustomisations.updatedAt,
            imagesUpdatedAt: weddingInviteCustomisations.imagesUpdatedAt,
          })
          .from(weddings)
          .leftJoin(
            weddingInviteCustomisations,
            eq(weddingInviteCustomisations.weddingId, weddings.id),
          )
          .where(eq(weddings.id, weddingId))
          .all(),
      );
      if (!row) return yield* Effect.fail(new WeddingNotFound({}));
      return toCustomisation(row.slug, row);
    }).pipe(Effect.withSpan("cire.invite.getForWeddingId"));
  },

  /**
   * Public read by wedding slug — drives the guest site. 404 for unknown slug.
   *
   * REDACTS the closing section. Everything else here (hero, story, events
   * header, welcome greeting, theme) is public by design: it paints the invite
   * shell that anyone opening the link sees before entering a code. The closing
   * section is not — it is the couple's sign-off to the invited household, so it
   * is delivered ONLY in the claim response (`claimService.lookup`), beside the
   * events list, to a session that proved household membership.
   *
   * This is the enforcement point for that gate. The guest site's
   * `<Show when={claimResult()}>` is presentation; without this redaction the
   * note would still be one unauthenticated `curl` away, and the render gate
   * would be decoration rather than a control.
   */
  getForSlug(slug: string): Effect.Effect<InviteCustomisation, WeddingNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [wedding] = yield* dbQuery(() =>
        db.select({ id: weddings.id }).from(weddings).where(eq(weddings.slug, slug)).all(),
      );
      if (!wedding) return yield* Effect.fail(new WeddingNotFound({ slug }));
      const full = yield* inviteService.getForWedding(wedding.id, slug);
      return { ...full, footer: EMPTY.footer };
    }).pipe(Effect.withSpan("cire.invite.getForSlug"));
  },

  /**
   * Does this claimed guest session belong to the wedding behind `slug`?
   *
   * The gate on the closing section's image. A valid `cire_session` proves the
   * holder claimed SOME household's code — not necessarily one at this wedding —
   * so the serve route must also bind the session to the slug it is asking for.
   * Without this, any guest of any wedding could read every other wedding's
   * motif, which is a lateral read, not a gate.
   */
  sessionOwnsWedding(familyId: string, slug: string): Effect.Effect<boolean, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select({ familyId: families.id })
          .from(families)
          .innerJoin(weddings, eq(weddings.id, families.weddingId))
          .where(and(eq(families.id, familyId), eq(weddings.slug, slug)))
          .all(),
      );
      return Boolean(row);
    }).pipe(Effect.withSpan("cire.invite.sessionOwnsWedding"));
  },

  /**
   * Resolve the R2 key backing a slug's image slot (for serving) PLUS the row's
   * IMAGE version (`imagesUpdatedAt`, coalesced to `updatedAt` for legacy rows;
   * migration 0029) — the authoritative content version — and the per-wedding
   * `heroBlur`. The serve route derives its edge-cache key from this server-side
   * version (not the client `?v=`), so an attacker can't loop distinct `?v=`
   * values to force unbounded, per-call-billed transforms (S-M1); and because
   * the version only moves on image upload/remove/crop + hero-blur changes,
   * copy/colour saves leave the transform cache warm (WT-P-I1). The version is
   * null when the wedding exists but has no customisation row yet (LEFT JOIN
   * miss) — the slot key is then null too, so the route 404s before it ever
   * builds a cache key.
   *
   * `heroBlur` is the per-wedding override of the hero backdrop's server-side
   * blur (migration 0018). It is resolved here alongside the key so the serve
   * route can apply it to the `hero-bg` transform WITHOUT a client query param
   * (preserving the no-arbitrary-cache-minting invariant) and fold it into the
   * cache key. A LEFT JOIN miss coalesces to the today's-look default.
   */
  imageKeyForSlug(
    slug: string,
    slot: InviteImageSlot,
  ): Effect.Effect<
    { key: string | null; imageVersion: Date | null; heroBlur: number },
    WeddingNotFound,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Single LEFT JOIN keyed on the slug: a missing weddings row is a 404; a
      // present wedding with a null-joined customisation is a legitimate
      // "no image yet" (IB-P-I1).
      const [row] = yield* dbQuery(() =>
        db
          .select({
            weddingId: weddings.id,
            heroImageKey: weddingInviteCustomisations.heroImageKey,
            storyImageKey: weddingInviteCustomisations.storyImageKey,
            footerImageKey: weddingInviteCustomisations.footerImageKey,
            heroBlur: weddingInviteCustomisations.heroBlur,
            updatedAt: weddingInviteCustomisations.updatedAt,
            imagesUpdatedAt: weddingInviteCustomisations.imagesUpdatedAt,
          })
          .from(weddings)
          .leftJoin(
            weddingInviteCustomisations,
            eq(weddingInviteCustomisations.weddingId, weddings.id),
          )
          .where(eq(weddings.slug, slug))
          .all(),
      );
      if (!row) return yield* Effect.fail(new WeddingNotFound({ slug }));
      const key = row[SLOT_COLUMNS[slot].key];
      return {
        key,
        imageVersion: row.imagesUpdatedAt ?? row.updatedAt,
        heroBlur: row.heroBlur ?? HERO_BLUR_DEFAULT,
      };
    }).pipe(Effect.withSpan("cire.invite.imageKeyForSlug"));
  },

  /** Upsert the text overrides for a wedding. Empty/whitespace clears to default. */
  upsertText(weddingId: string, fields: InviteTextBody): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const values = {
        heroTitle: normaliseCopy(fields.heroTitle),
        heroSubtitle: normaliseCopy(fields.heroSubtitle),
        storyEyebrow: normaliseCopy(fields.storyEyebrow),
        storyHeading: normaliseCopy(fields.storyHeading),
        storyBody: normaliseCopy(fields.storyBody),
        detailsEyebrow: normaliseCopy(fields.detailsEyebrow),
        detailsHeading: normaliseCopy(fields.detailsHeading),
        welcomeMessage: normaliseCopy(fields.welcomeMessage),
        footerMessage: normaliseCopy(fields.footerMessage),
        inviteMessage: normaliseCopy(fields.inviteMessage),
      };
      yield* dbQuery(() =>
        db
          .insert(weddingInviteCustomisations)
          .values({ weddingId, ...values, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: weddingInviteCustomisations.weddingId,
            set: { ...values, updatedAt: new Date() },
          })
          .run(),
      );
      yield* Effect.logInfo("invite text customisation saved", { weddingId });
      yield* Effect.sync(() => metricInviteSaved("ok"));
    }).pipe(Effect.withSpan("cire.invite.upsertText"));
  },

  /**
   * Upsert the invite theme — global fonts, the five colour seeds, the preset
   * key and the per-section tones. The body has already been schema-validated
   * (fonts/tones/preset ∈ closed enums, seeds ∈ the CSS-colour allow-list) at
   * the route boundary, so by the time it reaches here every value is safe to
   * persist; a `null` clears that field back to the built-in default.
   */
  upsertTheme(weddingId: string, fields: InviteThemeBody): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // Does this save change the served image bytes? Only `heroBlur` does (it
      // parameterises the `hero-bg` transform) — fonts/colours are pure CSS.
      // Bump the IMAGE version (`imagesUpdatedAt`, the ?v= + transform cache
      // key) only then, so a colour/font-only save leaves the guest image
      // caches warm instead of forcing fresh per-call-billed transforms
      // (WT-P-I1). A missing row counts as changed (first write seeds it).
      const [existing] = yield* dbQuery(() =>
        db
          .select({ heroBlur: weddingInviteCustomisations.heroBlur })
          .from(weddingInviteCustomisations)
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .all(),
      );
      const heroBlurChanged = !existing || existing.heroBlur !== fields.heroBlur;

      const values = {
        themeHeadingFont: fields.headingFont,
        themeBodyFont: fields.bodyFont,
        // Typography option keys (0048) — pure CSS, never bump the image version.
        themeHeadingSize: fields.headingSize,
        themeHeadingWeight: fields.headingWeight,
        themeHeadingStyle: fields.headingStyle,
        themeBodyWeight: fields.bodyWeight,
        themeBodyStyle: fields.bodyStyle,
        palettePreset: fields.palettePreset,
        paletteGround: fields.paletteGround,
        paletteCard: fields.paletteCard,
        paletteInk: fields.paletteInk,
        paletteGilt: fields.paletteGilt,
        paletteBloom: fields.paletteBloom,
        heroTone: fields.heroTone,
        storyTone: fields.storyTone,
        detailsTone: fields.detailsTone,
        welcomeTone: fields.welcomeTone,
        // Hero display sliders (already clamped into range by the schema decode).
        heroBlur: fields.heroBlur,
        heroTitleBackdropOpacity: fields.titleBackdropOpacity,
        heroTitleBackdropBlur: fields.titleBackdropBlur,
        // Conditional image-version bump — see heroBlurChanged above.
        ...(heroBlurChanged ? { imagesUpdatedAt: new Date() } : {}),
      };
      yield* dbQuery(() =>
        db
          .insert(weddingInviteCustomisations)
          .values({ weddingId, ...values, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: weddingInviteCustomisations.weddingId,
            set: { ...values, updatedAt: new Date() },
          })
          .run(),
      );
      yield* Effect.logInfo("invite theme customisation saved", { weddingId });
      yield* Effect.sync(() => metricInviteSaved("ok"));
    }).pipe(Effect.withSpan("cire.invite.upsertTheme"));
  },

  /**
   * Set which design pack the wedding's invite renders as. The id has already
   * passed catalog + entitlement checks at the route boundary. Bumps
   * `updatedAt` only — NEVER `imagesUpdatedAt` — a design switch changes no
   * stored image bytes, so the guest image transform caches stay warm
   * (WT-P-I1).
   */
  setDesign(weddingId: string, designId: string): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();
      yield* dbQuery(() =>
        db
          .insert(weddingInviteCustomisations)
          .values({ weddingId, designId, updatedAt: now })
          .onConflictDoUpdate({
            target: weddingInviteCustomisations.weddingId,
            set: { designId, updatedAt: now },
          })
          .run(),
      );
      yield* Effect.logInfo("invite design saved", { weddingId, designId });
      yield* Effect.sync(() => metricInviteSaved("ok"));
    }).pipe(Effect.withSpan("cire.invite.setDesign"));
  },

  /**
   * Store an uploaded image for a slot and point the row at it, deleting the
   * superseded object best-effort. Returns the new public image path.
   */
  setImage(
    weddingId: string,
    slug: string,
    slot: InviteImageSlot,
    bytes: ArrayBuffer,
    contentType: string,
  ): Effect.Effect<string, AssetR2Error, DbService | AssetsR2Service> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const keyColumn = SLOT_COLUMNS[slot].key;
      const column = weddingInviteCustomisations[keyColumn];

      const [existing] = yield* dbQuery(() =>
        db
          .select({ key: column })
          .from(weddingInviteCustomisations)
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .all(),
      );

      const newKey = yield* storeAsset(weddingId, slot, bytes, contentType);
      const now = new Date();
      // A fresh image invalidates the previous crop (it framed a different photo),
      // so reset the slot's crop(s) to the full-frame default on every upload —
      // for the hero that means BOTH rectangles (desktop + the 0046 mobile one).
      const cropResets = cropResetsFor(slot);

      yield* dbQuery(() =>
        db
          .insert(weddingInviteCustomisations)
          .values({
            weddingId,
            [keyColumn]: newKey,
            ...cropResets,
            updatedAt: now,
            imagesUpdatedAt: now,
          })
          .onConflictDoUpdate({
            target: weddingInviteCustomisations.weddingId,
            set: { [keyColumn]: newKey, ...cropResets, updatedAt: now, imagesUpdatedAt: now },
          })
          .run(),
      );

      // Best-effort: orphaning the old object is recoverable; failing the upload
      // because cleanup hiccuped is not worth it.
      if (existing?.key) {
        yield* deleteAsset(existing.key).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("invite image cleanup failed", { weddingId, reason: e.reason }),
          ),
        );
      }

      yield* Effect.logInfo("invite image uploaded", { weddingId });
      yield* Effect.sync(() => metricInviteAssetUploaded("ok", bytes.byteLength));
      return imagePath(slug, slot, now.getTime());
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricInviteAssetUploaded("error"))),
      Effect.withSpan("cire.invite.setImage"),
    );
  },

  /** Clear a slot's image (reset to default) and delete the object best-effort. */
  removeImage(
    weddingId: string,
    slot: InviteImageSlot,
  ): Effect.Effect<void, never, DbService | AssetsR2Service> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const keyColumn = SLOT_COLUMNS[slot].key;
      const column = weddingInviteCustomisations[keyColumn];
      const cropResets = cropResetsFor(slot);

      const [existing] = yield* dbQuery(() =>
        db
          .select({ key: column })
          .from(weddingInviteCustomisations)
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .all(),
      );

      yield* dbQuery(() =>
        db
          // Clear the crop(s) alongside the key — the slot is back to its default,
          // so a later re-upload starts full-frame, not with a stale crop.
          .update(weddingInviteCustomisations)
          .set({
            [keyColumn]: null,
            ...cropResets,
            updatedAt: new Date(),
            imagesUpdatedAt: new Date(),
          })
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .run(),
      );

      if (existing?.key) {
        yield* deleteAsset(existing.key).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("invite image cleanup failed", { weddingId, reason: e.reason }),
          ),
        );
      }
      yield* Effect.logInfo("invite image removed", { weddingId });
    }).pipe(Effect.withSpan("cire.invite.removeImage"));
  },

  /**
   * Save (or clear, with `crop: null`) the crop rectangle for a wedding-level
   * image slot. The rectangle has already passed the bounds validation at the
   * route boundary (`ImageCropBody`), so by the time it reaches here it is safe
   * to JSON-encode and persist. Bumping `updatedAt` is what makes the new crop
   * surface on the guest invite's no-store revalidation (and freshens the image
   * URL's `?v=` cache-buster, harmless under the CSS-render path).
   *
   * `screen` picks which rectangle a hero save targets (migration 0046):
   * `desktop` (the default — every pre-0046 caller) writes `heroImageCrop`,
   * `mobile` writes `heroImageCropMobile`. The route has already rejected
   * `mobile` for the story slot, so the story mapping ignores it.
   */
  setCrop(
    weddingId: string,
    slot: InviteImageSlot,
    crop: ImageCrop | null,
    screen: CropScreen = "desktop",
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const cols = SLOT_COLUMNS[slot];
      // `mobile` is hero-only and the route has already rejected it elsewhere;
      // fall back to the slot's single rectangle if one ever slips through.
      const keyColumn = screen === "mobile" ? (cols.cropMobile ?? cols.crop) : cols.crop;
      const encoded = crop ? JSON.stringify(crop) : null;
      const now = new Date();
      yield* dbQuery(() =>
        db
          .insert(weddingInviteCustomisations)
          .values({ weddingId, [keyColumn]: encoded, updatedAt: now, imagesUpdatedAt: now })
          .onConflictDoUpdate({
            target: weddingInviteCustomisations.weddingId,
            set: { [keyColumn]: encoded, updatedAt: now, imagesUpdatedAt: now },
          })
          .run(),
      );
      yield* Effect.logInfo("invite image crop saved", { weddingId });
    }).pipe(Effect.withSpan("cire.invite.setCrop"));
  },
};
