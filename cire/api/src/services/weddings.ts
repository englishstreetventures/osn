import { weddingHosts, weddings } from "@cire/db";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitBatch, DbService, dbQuery } from "../db";
import { epochSeconds, RESTORE_WINDOW_S, restoreUntil } from "../db/live-wedding";
import { metricWeddingCreated } from "../metrics";
import type { CodeStyle } from "./family-code";
import { normaliseHostRole } from "./hosts";
import type { WeddingRole } from "./hosts";

export type WeddingSummary = {
  id: string;
  slug: string;
  displayName: string;
  /** The caller's role on this wedding — the app-layer role of their seat,
   *  `owner` included. Lets the portal label each wedding and gate
   *  write/management surfaces; the API gates remain the enforcement, so a
   *  portal that does not recognise a role may mislabel it but can never widen
   *  what it reaches. */
  role: WeddingRole;
  /** Entitlement keys active on this wedding (e.g. `"vendors"`, `"capacity_500"`).
   *  Merged in by the route from `entitlementService.setsForWeddings` — the
   *  service itself stays free of entitlement logic. */
  entitlements: string[];
  /** Effective guest ceiling derived from the entitlement set. Defaults to 100. */
  guestCap: number;
};

/** A soft-deleted wedding its owner can still restore, as the list shows it. */
export type DeletedWeddingSummary = {
  id: string;
  slug: string;
  displayName: string;
  deletedAt: Date;
  restoreUntil: Date;
};

/** The organiser's weddings: live ones to open, deleted ones to restore. */
export type MemberWeddings = {
  weddings: WeddingSummary[];
  /** Only weddings the caller OWNS, and only inside the restore window. Never
   *  in `weddings`, so no reader of that list can open a deleted wedding. */
  deleted: DeletedWeddingSummary[];
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
   * Every wedding the given OSN profile can reach — one per seat they hold,
   * owned or co-hosted — oldest seat first, each tagged with that seat's role
   * (legacy `host` normalised to `editor`) so the portal can label it and gate
   * write + management surfaces. One query: a profile holds at most one seat
   * per wedding, so the join yields each wedding once.
   *
   * A soft-deleted wedding is never in `weddings`. It comes back in `deleted`
   * only to an owner, and only until its restore window closes; every other
   * seat loses it the moment it is deleted.
   */
  listForMember(
    osnProfileId: string,
    now: Date = new Date(),
  ): Effect.Effect<MemberWeddings, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const windowStartS = epochSeconds(now) - RESTORE_WINDOW_S;
      const rows = yield* dbQuery(() =>
        db
          .select({
            id: weddings.id,
            slug: weddings.slug,
            displayName: weddings.displayName,
            role: weddingHosts.role,
            deletedAt: weddings.deletedAt,
          })
          .from(weddingHosts)
          .innerJoin(weddings, eq(weddingHosts.weddingId, weddings.id))
          .where(
            and(
              eq(weddingHosts.osnProfileId, osnProfileId),
              or(
                isNull(weddings.deletedAt),
                and(eq(weddingHosts.role, "owner"), sql`${weddings.deletedAt} > ${windowStartS}`),
              ),
            ),
          )
          .orderBy(asc(weddingHosts.createdAt))
          // Defensive ceiling: an organiser holds a handful of seats, so this
          // never truncates real data — it just bounds the worst-case payload
          // if a single profile ever accumulates pathologically many.
          .limit(200)
          .all(),
      );
      const live: WeddingSummary[] = [];
      const deleted: DeletedWeddingSummary[] = [];
      for (const w of rows) {
        if (w.deletedAt === null) {
          live.push({
            id: w.id,
            slug: w.slug,
            displayName: w.displayName,
            role: normaliseHostRole(w.role),
            entitlements: [],
            guestCap: 100,
          });
        } else {
          deleted.push({
            id: w.id,
            slug: w.slug,
            displayName: w.displayName,
            deletedAt: w.deletedAt,
            restoreUntil: restoreUntil(w.deletedAt),
          });
        }
      }
      return { weddings: live, deleted };
    }).pipe(Effect.withSpan("cire.wedding.listForMember"));
  },

  /**
   * Create a new wedding owned by the caller. Generates the id + a unique slug
   * (base slug from the display name, plus a short random suffix to avoid
   * collisions with another owner's wedding of the same name — slug is globally
   * unique) and lands on the chosen `codeStyle` (default `secure`). The owner is
   * taken from the verified OSN token upstream, never from the request body; the
   * style is validated against the `["simple","secure"]` enum at the schema
   * boundary before reaching here.
   *
   * The wedding row and the caller's `owner` seat commit in one batch, so no
   * wedding ever exists without an owner. The seat names its own holder as the
   * one who added it.
   */
  createForOwner(
    osnProfileId: string,
    displayName: string,
    codeStyle: CodeStyle = "secure",
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

        // The one-argument form, not `{ try }` — that object overload also
        // requires a `catch`, and the failure is handled by the `catchAll`
        // below rather than at the boundary.
        const result = yield* Effect.tryPromise(() =>
          commitBatch(db, [
            db.insert(weddings).values({
              id,
              slug,
              displayName: trimmed,
              codeStyle,
              createdAt: now,
              updatedAt: now,
            }),
            db.insert(weddingHosts).values({
              id: `whost_${crypto.randomUUID()}`,
              weddingId: id,
              osnProfileId,
              addedByOsnProfileId: osnProfileId,
              role: "owner",
              createdAt: now,
            }),
          ]),
        ).pipe(
          Effect.map(() => ({
            ok: true as const,
            summary: {
              id,
              slug,
              displayName: trimmed,
              role: "owner" as const,
              entitlements: [] as string[],
              guestCap: 100,
            },
          })),
          Effect.catch((cause) =>
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
