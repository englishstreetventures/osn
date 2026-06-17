import { weddingHosts, weddings } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricWeddingCreated } from "../metrics";

export type WeddingSummary = {
  id: string;
  slug: string;
  displayName: string;
  /** True when the caller co-hosts (rather than owns) this wedding. Lets the
   *  portal label co-hosted weddings and hide owner-only management. */
  role: "owner" | "host";
};

/** Raised when a new wedding row cannot be persisted (slug collisions are
 *  retried internally; this surfaces only after exhausting the retries or on a
 *  driver error). */
export class WeddingCreateError extends Data.TaggedError("WeddingCreateError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** Max display-name length accepted from the organiser portal. */
export const MAX_DISPLAY_NAME = 120;

/**
 * Derive a URL-safe base slug from a display name: lowercase, ASCII-ish, words
 * joined by single hyphens. Empty input (e.g. an all-emoji name) falls back to
 * `"wedding"` so we always have something to suffix.
 */
export function slugifyDisplayName(displayName: string): string {
  const base = displayName
    .normalize("NFKD")
    // Drop combining marks left by NFKD so "José" → "jose", not "jose<mark>".
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : "wedding";
}

/** New wedding id: `wed_<uuid-hex>`. Matches the codebase's `crypto.randomUUID`
 *  id convention (no ulid dependency); `wed_bootstrap` stays reserved. */
function mintWeddingId(): string {
  return `wed_${crypto.randomUUID().replace(/-/g, "")}`;
}

export const weddingsService = {
  /**
   * Every wedding the given OSN profile can reach: the ones they OWN plus the
   * ones they CO-HOST, oldest-owned-first then oldest-hosted. Owned rows are
   * tagged `role: "owner"`, co-hosted rows `role: "host"` so the portal can
   * label them and gate owner-only management. A profile can't both own and
   * co-host the same wedding (the owner is never rowed into `wedding_hosts`), so
   * no dedupe is needed.
   */
  listForMember(osnProfileId: string): Effect.Effect<WeddingSummary[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const owned = yield* dbQuery(() =>
        db
          .select({
            id: weddings.id,
            slug: weddings.slug,
            displayName: weddings.displayName,
          })
          .from(weddings)
          .where(eq(weddings.ownerOsnProfileId, osnProfileId))
          .orderBy(asc(weddings.createdAt))
          // Defensive ceiling (P-I1): an organiser hosts a handful of weddings,
          // so this never truncates real data — it just bounds the worst-case
          // payload if a single profile ever accumulates pathologically many.
          .limit(200)
          .all(),
      );
      const hosted = yield* dbQuery(() =>
        db
          .select({
            id: weddings.id,
            slug: weddings.slug,
            displayName: weddings.displayName,
          })
          .from(weddingHosts)
          .innerJoin(weddings, eq(weddingHosts.weddingId, weddings.id))
          .where(eq(weddingHosts.osnProfileId, osnProfileId))
          .orderBy(asc(weddingHosts.createdAt))
          .limit(200)
          .all(),
      );
      const summaries: WeddingSummary[] = [];
      for (const w of owned) {
        summaries.push({ id: w.id, slug: w.slug, displayName: w.displayName, role: "owner" });
      }
      for (const w of hosted) {
        summaries.push({ id: w.id, slug: w.slug, displayName: w.displayName, role: "host" });
      }
      return summaries;
    }).pipe(Effect.withSpan("cire.wedding.listForMember"));
  },

  /**
   * Create a new wedding owned by the caller. Generates the id + a unique slug
   * (base slug from the display name, plus a short random suffix to avoid
   * collisions with another owner's wedding of the same name — slug is globally
   * unique) and lands on the default `secure` code style. The owner is taken
   * from the verified OSN token upstream, never from the request body.
   */
  createForOwner(
    osnProfileId: string,
    displayName: string,
  ): Effect.Effect<WeddingSummary, WeddingCreateError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const trimmed = displayName.trim();
      const base = slugifyDisplayName(trimmed);
      const now = new Date();

      // Try a few slugs before giving up — the suffix is 6 hex chars (24 bits),
      // so a collision under one owner's handful of weddings is astronomically
      // unlikely, but the retry keeps the unique-index violation from surfacing
      // as a 500 in the rare case.
      const MAX_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const id = mintWeddingId();
        const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
        const slug = `${base}-${suffix}`;

        const result = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              db
                .insert(weddings)
                .values({
                  id,
                  slug,
                  displayName: trimmed,
                  ownerOsnProfileId: osnProfileId,
                  codeStyle: "secure",
                  createdAt: now,
                  updatedAt: now,
                })
                .run(),
            ),
        }).pipe(
          Effect.map(() => ({
            ok: true as const,
            summary: { id, slug, displayName: trimmed, role: "owner" as const },
          })),
          Effect.catchAll((cause) =>
            // A UNIQUE violation on slug/id is retryable; surface anything else
            // on the final attempt as a WeddingCreateError.
            Effect.succeed({ ok: false as const, cause }),
          ),
        );

        if (result.ok) return result.summary;
        if (attempt === MAX_ATTEMPTS - 1) {
          yield* Effect.logError("wedding create failed", { reason: "insert" });
          return yield* new WeddingCreateError({ reason: "insert", cause: result.cause });
        }
      }
      // Unreachable — the loop either returns a summary or fails on the last
      // attempt. Kept to satisfy the type checker.
      return yield* new WeddingCreateError({ reason: "exhausted" });
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricWeddingCreated("ok"))),
      Effect.tapError(() => Effect.sync(() => metricWeddingCreated("error"))),
      Effect.withSpan("cire.wedding.createForOwner"),
    );
  },
};
