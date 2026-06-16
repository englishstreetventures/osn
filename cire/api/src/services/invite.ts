import { weddingInviteCustomisations, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { InviteImageSlot, InviteTextBody } from "../schemas/invite";
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
export interface InviteCustomisation {
  hero: { title: string | null; subtitle: string | null; imageUrl: string | null };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
  };
}

const EMPTY: InviteCustomisation = {
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
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

  /** Resolve the R2 key backing a slug's image slot (for serving). */
  imageKeyForSlug(
    slug: string,
    slot: InviteImageSlot,
  ): Effect.Effect<string | null, WeddingNotFound, DbService> {
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
      return slot === "hero" ? row.heroImageKey : row.storyImageKey;
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
    }).pipe(Effect.withSpan("cire.invite.upsertText"));
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
      return imagePath(slug, slot, now.getTime());
    }).pipe(Effect.withSpan("cire.invite.setImage"));
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
