import { events, weddings } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricInviteAssetUploaded } from "../metrics";
import type { ImageCrop } from "../schemas/invite";
import { deleteAsset, storeAsset } from "./invite-assets";
import type { AssetR2Error, AssetsR2Service } from "./invite-assets";

/**
 * Per-event image storage — the events analogue of the wedding-level slot
 * methods in `invite.ts` (`setImage`/`removeImage`/`imageKeyForSlug`). One
 * optional image per event, keyed by event id (the cap is structural — a single
 * `events.event_image_key` column, so there is exactly one slot per event and a
 * re-upload REPLACES it). Bytes live in the shared `cire-assets` R2 bucket under
 * the same `assets/<weddingId>/...` namespace; the column stores the **key**,
 * not a URL (mirrors `hero_image_key` / `story_image_key`).
 *
 * Cache version: events have no `updated_at` column, so the served image's
 * version is derived SERVER-SIDE from the stored key itself — the key carries a
 * fresh uuid per upload (see `invite-assets.storeAsset`), so a re-upload mints a
 * new key ⇒ a new version ⇒ the new image is never served stale, while the
 * client `?v=` is never trusted for cache keying (preserves the S-M1 invariant).
 */

export class EventNotFound extends Data.TaggedError("EventNotFound")<{
  readonly eventId?: string;
}> {}

/**
 * A short, stable cache-version token derived from an R2 image key. The key
 * already changes on every upload (fresh uuid suffix), so a cheap deterministic
 * digest of it is a sufficient content version: it changes exactly when the
 * image changes, is computed entirely server-side, and never depends on the
 * client `?v=`. Hex of a 32-bit FNV-1a hash — short, collision-resistant enough
 * for a cache buster (not a security primitive).
 */
export function versionFromKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Public path an event image is served from. Clients prepend the API origin. */
export function eventImagePath(slug: string, eventId: string, version: string): string {
  return `/api/invite/${encodeURIComponent(slug)}/event/${encodeURIComponent(eventId)}/image?v=${version}`;
}

export const eventImageService = {
  /**
   * Resolve a slug + event id → the event's image R2 key (for serving) plus the
   * key-derived content version. Authorises the event belongs to the wedding
   * named by `slug`: an event id from another wedding resolves to no row →
   * `EventNotFound` (the serve route 404s before it ever builds a cache key).
   * `key` is null when the event exists but has no image yet — also a 404.
   */
  imageKeyForEvent(
    slug: string,
    eventId: string,
  ): Effect.Effect<{ key: string | null; version: string | null }, EventNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Join through weddings on the slug so the event id is scoped to that
      // wedding — a cross-wedding event id matches no row (no tenant leak).
      const [row] = yield* dbQuery(() =>
        db
          .select({ key: events.eventImageKey })
          .from(events)
          .innerJoin(weddings, eq(events.weddingId, weddings.id))
          .where(and(eq(weddings.slug, slug), eq(events.id, eventId)))
          .all(),
      );
      if (!row) return yield* Effect.fail(new EventNotFound({ eventId }));
      return { key: row.key, version: row.key ? versionFromKey(row.key) : null };
    }).pipe(Effect.withSpan("cire.event_image.imageKeyForEvent"));
  },

  /**
   * Store an uploaded image for an event and point the row at it, deleting the
   * superseded object best-effort (mirrors `inviteService.setImage`). Authorises
   * the event belongs to `weddingId` — an event from another wedding is rejected
   * (`EventNotFound`) and never written. Returns the new public image path.
   */
  setImage(
    weddingId: string,
    slug: string,
    eventId: string,
    bytes: ArrayBuffer,
    contentType: string,
  ): Effect.Effect<string, AssetR2Error | EventNotFound, DbService | AssetsR2Service> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Ownership check: the event must belong to this wedding. Reading the
      // existing key in the same query lets us clean up the superseded object.
      const [existing] = yield* dbQuery(() =>
        db
          .select({ key: events.eventImageKey })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new EventNotFound({ eventId }));

      // Reuse the invite-image R2 namespace/helpers; the slot label is "event"
      // (the key still carries a fresh uuid, so it never collides per upload).
      const newKey = yield* storeAsset(weddingId, "event", bytes, contentType);

      yield* dbQuery(() =>
        db
          // A fresh image invalidates the previous crop (it framed a different
          // photo), so reset it to the full-frame default on every upload.
          .update(events)
          .set({ eventImageKey: newKey, eventImageCrop: null })
          .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
          .run(),
      );

      // Best-effort: orphaning the old object is recoverable; failing the upload
      // because cleanup hiccuped is not.
      if (existing.key) {
        yield* deleteAsset(existing.key).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("event image cleanup failed", { weddingId, reason: e.reason }),
          ),
        );
      }

      yield* Effect.logInfo("event image uploaded", { weddingId });
      yield* Effect.sync(() => metricInviteAssetUploaded("ok", bytes.byteLength));
      return eventImagePath(slug, eventId, versionFromKey(newKey));
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricInviteAssetUploaded("error"))),
      Effect.withSpan("cire.event_image.setImage"),
    );
  },

  /**
   * Clear an event's image and delete the object best-effort. Authorises the
   * event belongs to `weddingId`; a no-image event is a harmless no-op (still
   * 200). An event from another wedding is rejected (`EventNotFound`).
   */
  removeImage(
    weddingId: string,
    eventId: string,
  ): Effect.Effect<void, EventNotFound, DbService | AssetsR2Service> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [existing] = yield* dbQuery(() =>
        db
          .select({ key: events.eventImageKey })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new EventNotFound({ eventId }));

      yield* dbQuery(() =>
        db
          .update(events)
          .set({ eventImageKey: null })
          .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
          .run(),
      );

      if (existing.key) {
        yield* deleteAsset(existing.key).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("event image cleanup failed", { weddingId, reason: e.reason }),
          ),
        );
      }
      yield* Effect.logInfo("event image removed", { weddingId });
    }).pipe(Effect.withSpan("cire.event_image.removeImage"));
  },

  /**
   * Save (or clear, with `crop: null`) the crop rectangle for an event's image.
   * Authorises the event belongs to `weddingId` — an event from another wedding
   * is rejected (`EventNotFound`) and never written. The rectangle has already
   * passed the bounds validation at the route boundary (`ImageCropBody`). Events
   * have no `updated_at`; the served bytes are unchanged under the CSS-render
   * path and the crop rides in the no-store claim/list JSON, so no cache bump is
   * needed here.
   */
  setCrop(
    weddingId: string,
    eventId: string,
    crop: ImageCrop | null,
  ): Effect.Effect<void, EventNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [existing] = yield* dbQuery(() =>
        db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new EventNotFound({ eventId }));

      const encoded = crop ? JSON.stringify(crop) : null;
      yield* dbQuery(() =>
        db
          .update(events)
          .set({ eventImageCrop: encoded })
          .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
          .run(),
      );
      yield* Effect.logInfo("event image crop saved", { weddingId });
    }).pipe(Effect.withSpan("cire.event_image.setCrop"));
  },
};
