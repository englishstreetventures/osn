import { events, families, guests, guestEvents, weddings } from "@cire/db";
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Data } from "effect";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { metricHostCodeEnsured } from "../metrics";

export class HostCodeError extends Data.TaggedError("HostCodeError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * Commit a write set atomically across both drivers. D1 has no interactive
 * transaction, so the statements are batched into one round-trip; bun:sqlite
 * (tests/local) has no `.batch()`, so they run sequentially in-process. Same
 * feature-detected idiom as `import.ts`'s `commitWriteSet`.
 */
async function commitBatch(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  if (statements.length === 0) return;
  const batchable = db as {
    batch?: (s: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<unknown>;
  };
  if (typeof batchable.batch === "function") {
    await batchable.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    return;
  }
  // eslint-disable-next-line no-await-in-loop
  for (const stmt of statements) await stmt;
}

/** Display name for the synthetic host family + its single member. The web
 *  invite renders these only behind the "preview" banner, so they never reach
 *  a real guest. */
const HOST_FAMILY_NAME = "Host Preview";
const HOST_GUEST_FIRST = "Wedding";
const HOST_GUEST_LAST = "Host";

/**
 * Mint a `HOST-*` claim code with 128 bits of CSPRNG entropy (16 raw
 * `crypto.getRandomValues` bytes, hex-encoded) — well above the project's
 * 112-bit credential bar and far stronger than the 32-bit family code, because
 * this one code unlocks every event in the wedding. Raw bytes (not UUID hex,
 * which wastes bits on fixed version/variant nibbles) give full entropy per
 * char. The `HOST-` prefix keeps it visually distinct from family codes and out
 * of their namespace. Host codes are organiser deep-links, never hand-typed, so
 * the length is unconstrained by the guest input's manual cap.
 */
function mintHostPublicId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `HOST-${suffix}`;
}

export const hostCodeService = {
  /**
   * Idempotently provision the host preview code for a wedding and return its
   * claim code PLUS the wedding's slug. The organiser dashboard opens the guest
   * invite at `${CIRE_WEB_URL}/<slug>?code=<publicId>` — the slug lives in the
   * PATH (the guest site is SSR + path-routed), so the preview opens the CORRECT
   * wedding regardless of which one the organiser is managing. Find-or-creates
   * the single host family + its one synthetic guest, then (re-)links that guest
   * to **every** event in the wedding so the preview always reflects the current
   * event list — including events added by a later spreadsheet import (which
   * deliberately skips host families).
   *
   * weddingId is caller-supplied and already membership-checked by
   * `weddingMember()` upstream (any role — previewing is the read experience);
   * this method does not re-authorise.
   */
  ensureForWedding(
    weddingId: string,
  ): Effect.Effect<{ publicId: string; slug: string }, HostCodeError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();

      // The wedding's slug for the path-routed preview link. weddingMember()
      // already proved the wedding exists, so a missing row here is a real
      // invariant break — surface it as a HostCodeError, not a silent default.
      const [wedding] = yield* dbQuery(() =>
        db.select({ slug: weddings.slug }).from(weddings).where(eq(weddings.id, weddingId)).all(),
      );
      if (!wedding) {
        return yield* new HostCodeError({ reason: "wedding not found" });
      }
      const slug = wedding.slug;

      const write = (op: string, run: () => unknown | Promise<unknown>) =>
        Effect.tryPromise({
          try: () => Promise.resolve(run()),
          catch: (cause) => new HostCodeError({ reason: op, cause }),
        }).pipe(
          Effect.tapError((err) => Effect.logError("host-code write failed", { op: err.reason })),
        );

      // Find-or-create the single host family for this wedding.
      const [existing] = yield* dbQuery(() =>
        db
          .select({ id: families.id, publicId: families.publicId })
          .from(families)
          .where(and(eq(families.weddingId, weddingId), eq(families.kind, "host")))
          .all(),
      );

      let familyId: string;
      let publicId: string;
      if (existing) {
        familyId = existing.id;
        publicId = existing.publicId;
      } else {
        familyId = crypto.randomUUID();
        publicId = mintHostPublicId();
        yield* write("insert family", () =>
          db
            .insert(families)
            .values({
              id: familyId,
              weddingId,
              publicId,
              familyName: HOST_FAMILY_NAME,
              kind: "host",
              createdAt: now,
              updatedAt: now,
            })
            .run(),
        );
      }

      // Ensure the host family has exactly one member to carry event links.
      const [hostGuest] = yield* dbQuery(() =>
        db.select({ id: guests.id }).from(guests).where(eq(guests.familyId, familyId)).all(),
      );
      let hostGuestId: string;
      if (hostGuest) {
        hostGuestId = hostGuest.id;
      } else {
        hostGuestId = crypto.randomUUID();
        yield* write("insert guest", () =>
          db
            .insert(guests)
            .values({
              id: hostGuestId,
              familyId,
              firstName: HOST_GUEST_FIRST,
              lastName: HOST_GUEST_LAST,
              sortOrder: 0,
              createdAt: now,
              updatedAt: now,
            })
            .run(),
        );
      }

      // (Re-)link the host guest to every event in the wedding. Idempotent:
      // only the missing links are inserted, so repeated previews are cheap and
      // newly imported events get picked up on the next call.
      const eventRows = yield* dbQuery(() =>
        db.select({ id: events.id }).from(events).where(eq(events.weddingId, weddingId)).all(),
      );
      const existingLinks = yield* dbQuery(() =>
        db
          .select({ eventId: guestEvents.eventId })
          .from(guestEvents)
          .where(eq(guestEvents.guestId, hostGuestId))
          .all(),
      );
      const linked = new Set(existingLinks.map((l) => l.eventId));
      const missing = eventRows.filter((e) => !linked.has(e.id));
      if (missing.length > 0) {
        // One atomic batch (D1) / sequential run (bun:sqlite) instead of a
        // round-trip per event — P-W1. `onConflictDoNothing` + the guest_events
        // PK keep it idempotent across concurrent previews.
        const statements = missing.map((e) =>
          db
            .insert(guestEvents)
            .values({ guestId: hostGuestId, eventId: e.id })
            .onConflictDoNothing(),
        ) as BatchItem<"sqlite">[];
        yield* write("link events", () => commitBatch(db, statements));
      }

      return { publicId, slug };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricHostCodeEnsured("ok"))),
      Effect.tapError(() => Effect.sync(() => metricHostCodeEnsured("error"))),
      Effect.withSpan("cire.host_code.ensure"),
    );
  },
};
