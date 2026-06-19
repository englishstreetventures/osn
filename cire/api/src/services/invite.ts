import { weddingInviteCustomisations, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricInviteAssetUploaded, metricInviteSaved } from "../metrics";
import {
  HERO_BLUR_DEFAULT,
  type FontChoice,
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
  hero: { accentColor: string | null; surfaceColor: string | null };
  story: { accentColor: string | null; surfaceColor: string | null };
  details: { accentColor: string | null; surfaceColor: string | null };
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
  hero: { title: string | null; subtitle: string | null; imageUrl: string | null };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
  };
  heroDisplay: HeroDisplay;
  theme: InviteTheme;
}

const EMPTY_THEME: InviteTheme = {
  headingFont: null,
  bodyFont: null,
  hero: { accentColor: null, surfaceColor: null },
  story: { accentColor: null, surfaceColor: null },
  details: { accentColor: null, surfaceColor: null },
};

// The defaults a wedding with no customisation row reports — identical to the
// NOT-NULL column defaults (0018), so a missing row and a default row render the
// same. `blur: 28` reproduces the former fixed `VARIANT_BLUR["hero-bg"]` look.
const DEFAULT_HERO_DISPLAY: HeroDisplay = {
  blur: HERO_BLUR_DEFAULT,
  titleBackdrop: { opacity: 0, blur: 0 },
};

const EMPTY: InviteCustomisation = {
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: DEFAULT_HERO_DISPLAY,
  theme: EMPTY_THEME,
};

/** Public path the invite image is served from. Clients prepend the API origin. */
function imagePath(slug: string, slot: InviteImageSlot, version: number): string {
  return `/api/invite/${encodeURIComponent(slug)}/image/${slot}?v=${version}`;
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
    heroImageKey: string | null;
    storyImageKey: string | null;
    // NOT NULL columns, but a LEFT JOIN miss (no customisation row) yields null —
    // coalesced to the today's-look default below.
    heroBlur: number | null;
    heroTitleBackdropOpacity: number | null;
    heroTitleBackdropBlur: number | null;
    themeHeadingFont: string | null;
    themeBodyFont: string | null;
    heroAccentColor: string | null;
    heroSurfaceColor: string | null;
    storyAccentColor: string | null;
    storySurfaceColor: string | null;
    detailsAccentColor: string | null;
    detailsSurfaceColor: string | null;
    updatedAt: Date | null;
  },
): InviteCustomisation {
  const version = c.updatedAt ? c.updatedAt.getTime() : 0;
  return {
    hero: {
      title: c.heroTitle,
      subtitle: c.heroSubtitle,
      imageUrl: c.heroImageKey ? imagePath(slug, "hero", version) : null,
    },
    story: {
      eyebrow: c.storyEyebrow,
      heading: c.storyHeading,
      body: c.storyBody,
      imageUrl: c.storyImageKey ? imagePath(slug, "story", version) : null,
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
      hero: { accentColor: c.heroAccentColor, surfaceColor: c.heroSurfaceColor },
      story: { accentColor: c.storyAccentColor, surfaceColor: c.storySurfaceColor },
      details: { accentColor: c.detailsAccentColor, surfaceColor: c.detailsSurfaceColor },
    },
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
            heroImageKey: weddingInviteCustomisations.heroImageKey,
            storyImageKey: weddingInviteCustomisations.storyImageKey,
            heroBlur: weddingInviteCustomisations.heroBlur,
            heroTitleBackdropOpacity: weddingInviteCustomisations.heroTitleBackdropOpacity,
            heroTitleBackdropBlur: weddingInviteCustomisations.heroTitleBackdropBlur,
            themeHeadingFont: weddingInviteCustomisations.themeHeadingFont,
            themeBodyFont: weddingInviteCustomisations.themeBodyFont,
            heroAccentColor: weddingInviteCustomisations.heroAccentColor,
            heroSurfaceColor: weddingInviteCustomisations.heroSurfaceColor,
            storyAccentColor: weddingInviteCustomisations.storyAccentColor,
            storySurfaceColor: weddingInviteCustomisations.storySurfaceColor,
            detailsAccentColor: weddingInviteCustomisations.detailsAccentColor,
            detailsSurfaceColor: weddingInviteCustomisations.detailsSurfaceColor,
            updatedAt: weddingInviteCustomisations.updatedAt,
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

  /** Public read by wedding slug — drives the guest site. 404 for unknown slug. */
  getForSlug(slug: string): Effect.Effect<InviteCustomisation, WeddingNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [wedding] = yield* dbQuery(() =>
        db.select({ id: weddings.id }).from(weddings).where(eq(weddings.slug, slug)).all(),
      );
      if (!wedding) return yield* Effect.fail(new WeddingNotFound({ slug }));
      return yield* inviteService.getForWedding(wedding.id, slug);
    }).pipe(Effect.withSpan("cire.invite.getForSlug"));
  },

  /**
   * Resolve the R2 key backing a slug's image slot (for serving) PLUS the row's
   * `updatedAt` — the authoritative content version — and the per-wedding
   * `heroBlur`. The serve route derives its edge-cache key from this server-side
   * `updatedAt` (not the client `?v=`), so an attacker can't loop distinct `?v=`
   * values to force unbounded, per-call-billed transforms (S-M1). `updatedAt` is
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
    { key: string | null; updatedAt: Date | null; heroBlur: number },
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
            heroBlur: weddingInviteCustomisations.heroBlur,
            updatedAt: weddingInviteCustomisations.updatedAt,
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
      const key = slot === "hero" ? row.heroImageKey : row.storyImageKey;
      return { key, updatedAt: row.updatedAt, heroBlur: row.heroBlur ?? HERO_BLUR_DEFAULT };
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
   * Upsert the per-section theme (fonts + colours) for a wedding. The body has
   * already been schema-validated (fonts ∈ closed enum, colours ∈ allow-list) at
   * the route boundary, so by the time it reaches here every value is safe to
   * persist; a `null` clears that field back to the built-in default token.
   */
  upsertTheme(weddingId: string, fields: InviteThemeBody): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const values = {
        themeHeadingFont: fields.headingFont,
        themeBodyFont: fields.bodyFont,
        heroAccentColor: fields.heroAccentColor,
        heroSurfaceColor: fields.heroSurfaceColor,
        storyAccentColor: fields.storyAccentColor,
        storySurfaceColor: fields.storySurfaceColor,
        detailsAccentColor: fields.detailsAccentColor,
        detailsSurfaceColor: fields.detailsSurfaceColor,
        // Hero display sliders (already clamped into range by the schema decode).
        // Persisting these bumps `updatedAt` below — critical because the hero
        // image cache version derives from `updatedAt`, so changing `heroBlur`
        // must bust the served `hero-bg` transform cache.
        heroBlur: fields.heroBlur,
        heroTitleBackdropOpacity: fields.titleBackdropOpacity,
        heroTitleBackdropBlur: fields.titleBackdropBlur,
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
      const column =
        slot === "hero"
          ? weddingInviteCustomisations.heroImageKey
          : weddingInviteCustomisations.storyImageKey;

      const [existing] = yield* dbQuery(() =>
        db
          .select({ key: column })
          .from(weddingInviteCustomisations)
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .all(),
      );

      const newKey = yield* storeAsset(weddingId, slot, bytes, contentType);
      const now = new Date();
      const keyColumn = slot === "hero" ? "heroImageKey" : "storyImageKey";

      yield* dbQuery(() =>
        db
          .insert(weddingInviteCustomisations)
          .values({ weddingId, [keyColumn]: newKey, updatedAt: now })
          .onConflictDoUpdate({
            target: weddingInviteCustomisations.weddingId,
            set: { [keyColumn]: newKey, updatedAt: now },
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
      const column =
        slot === "hero"
          ? weddingInviteCustomisations.heroImageKey
          : weddingInviteCustomisations.storyImageKey;
      const keyColumn = slot === "hero" ? "heroImageKey" : "storyImageKey";

      const [existing] = yield* dbQuery(() =>
        db
          .select({ key: column })
          .from(weddingInviteCustomisations)
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .all(),
      );

      yield* dbQuery(() =>
        db
          .update(weddingInviteCustomisations)
          .set({ [keyColumn]: null, updatedAt: new Date() })
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
};
