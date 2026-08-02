import {
  families,
  guests,
  events,
  guestEvents,
  rsvps,
  weddingInviteCustomisations,
  weddings,
} from "@cire/db";
import { eq, and, asc, count, inArray, ne, isNull } from "drizzle-orm";
import { Effect, Data } from "effect";

import { DbService, dbQuery } from "../db";
import { resolveRsvpDeadline } from "../lib/rsvp-deadline";
import { measureClaimLookup, metricClaimAttempt, metricInviteOpened } from "../metrics";
import type {
  ClaimResponse,
  OrganiserGuestRow,
  OrganiserHouseholdRow,
  DressSwatch,
} from "../schemas/claim";
import { decodeCrop, type ImageCrop } from "../schemas/invite";
import { eventImagePath, versionFromKey } from "./event-image";

export class InvalidCredentials extends Data.TaggedError("InvalidCredentials") {}

/**
 * Defence-in-depth: drop any stored URL whose scheme isn't http(s) so a
 * legacy row written before the CSV-import scheme check can't smuggle a
 * `javascript:` href into the organiser UI. Exported for the events CSV
 * export, which surfaces the same stored URLs.
 */
export function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Decode the JSON-encoded `dress_code_palette` column. Returns `palette: null`
 * + `malformed: true` so the caller can emit a structured log line referencing
 * the offending event id (kept out of this pure helper to preserve testability
 * and avoid threading Effect through every call site). Exported for the events
 * CSV export, which renders the same swatches as text.
 */
export function decodePalette(raw: string | null): {
  palette: readonly DressSwatch[] | null;
  malformed: boolean;
} {
  if (!raw) return { palette: null, malformed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { palette: null, malformed: true };
  }
  if (!Array.isArray(parsed)) return { palette: null, malformed: true };
  const out: DressSwatch[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).name === "string" &&
      typeof (item as Record<string, unknown>).color === "string"
    ) {
      const t = item as { name: string; color: string };
      out.push({ name: t.name, color: t.color });
    }
  }
  return { palette: out, malformed: false };
}

/**
 * Public path to an event's image, or null when it has none. The version is
 * derived SERVER-SIDE from the stored R2 key (events have no `updated_at`), so a
 * re-upload mints a fresh key ⇒ a fresh version ⇒ the new image is never served
 * stale, while the client `?v=` is never trusted for cache keying (S-M1). The
 * slug scopes the path to this wedding; the guest site prepends its API origin.
 */
function eventImageUrl(slug: string, eventId: string, key: string | null): string | null {
  return key ? eventImagePath(slug, eventId, versionFromKey(key)) : null;
}

/**
 * Decode an event's stored crop rectangle, but only when it actually has an
 * image — a rectangle left on a since-removed image is inert. `decodeCrop` drops
 * a malformed/legacy value to null so a bad rectangle never reaches the guest
 * site's inline style.
 */
function eventImageCrop(key: string | null, raw: string | null): ImageCrop | null {
  return key ? decodeCrop(raw) : null;
}

/**
 * The row shape both entry points below resolve before building a response —
 * `lookup` by claim code, `restore` by the session's family id.
 */
type FamilyRow = typeof families.$inferSelect;

/**
 * Build the invite payload for an already-resolved household. Shared by
 * `claimService.lookup` (code entry) and `claimService.restore` (an existing
 * `cire_session` re-reading its own invite), so the two can never drift into
 * serving different views of the same household — which matters because this
 * payload is the ONLY delivery point for the events list and the closing
 * section (S-H1). Pure read: the caller owns the credential check, the
 * first-open write and the metrics.
 */
function buildClaimResponse(family: FamilyRow): Effect.Effect<ClaimResponse, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    // Three genuinely INDEPENDENT reads, each keyed only off the already-resolved
    // `family` row, so they're pipelined together with `Effect.all` (P-W2): on D1
    // their three round-trips overlap (~1 fewer serial RTT on the hot path), and
    // on bun:sqlite (tests/local) they resolve in-process so concurrency is a
    // harmless no-op. The events read can't join this group — it depends on the
    // event ids derived from `guestRows` below — so it stays sequential after.
    //  (a) the wedding row — its slug scopes the first-party event-image paths,
    //      and its RSVP-deadline columns tell the guest site whether (and when)
    //      the invite locks. A family always belongs to a wedding (FK), so the
    //      row is present; default to the family's weddingId if a slug is somehow
    //      absent (image URLs would 404, but the rest of the claim is unaffected
    //      — never fail the lookup on it).
    //  (b) guests + their event-id memberships. Kept narrow (no events join) to
    //      avoid the cartesian explosion of duplicating every event row — incl.
    //      its JSON palette blob — once per invited guest.
    //  (c) this family's RSVPs.
    const {
      wedding: [wedding],
      closingRow: [closing],
      guestRows,
      rsvpRows,
    } = yield* Effect.all(
      {
        wedding: dbQuery(() =>
          db
            .select({
              slug: weddings.slug,
              rsvpDeadline: weddings.rsvpDeadline,
              rsvpDeadlineTimezone: weddings.rsvpDeadlineTimezone,
            })
            .from(weddings)
            .where(eq(weddings.id, family.weddingId))
            .all(),
        ),
        // The CLOSING SECTION (the couple's sign-off) rides the claim payload,
        // NOT the public `GET /api/invite/:slug` — it is addressed to the
        // invited household, so it is delivered only to a session that proved
        // household membership, exactly like the events list beside it.
        closingRow: dbQuery(() =>
          db
            .select({
              message: weddingInviteCustomisations.footerMessage,
              imageKey: weddingInviteCustomisations.footerImageKey,
              imageCrop: weddingInviteCustomisations.footerImageCrop,
              updatedAt: weddingInviteCustomisations.updatedAt,
              imagesUpdatedAt: weddingInviteCustomisations.imagesUpdatedAt,
            })
            .from(weddingInviteCustomisations)
            .where(eq(weddingInviteCustomisations.weddingId, family.weddingId))
            .all(),
        ),
        guestRows: dbQuery(() =>
          db
            .select({
              guestId: guests.id,
              firstName: guests.firstName,
              lastName: guests.lastName,
              nickname: guests.nickname,
              sortOrder: guests.sortOrder,
              eventId: guestEvents.eventId,
            })
            .from(guests)
            .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
            .where(eq(guests.familyId, family.id))
            .orderBy(asc(guests.sortOrder))
            .all(),
        ),
        rsvpRows: dbQuery(() =>
          db
            .select({
              guestId: rsvps.guestId,
              eventId: rsvps.eventId,
              status: rsvps.status,
              dietary: rsvps.dietary,
            })
            .from(rsvps)
            .innerJoin(guests, eq(rsvps.guestId, guests.id))
            .where(eq(guests.familyId, family.id))
            .all(),
        ),
      },
      { concurrency: "unbounded" },
    );
    const slug = wedding?.slug ?? family.weddingId;

    const memberMap = new Map<
      string,
      {
        guestId: string;
        firstName: string;
        lastName: string;
        nickname: string | null;
        eventIds: string[];
      }
    >();
    const eventIds = new Set<string>();
    for (const row of guestRows) {
      let member = memberMap.get(row.guestId);
      if (!member) {
        member = {
          guestId: row.guestId,
          firstName: row.firstName,
          lastName: row.lastName,
          nickname: row.nickname,
          eventIds: [],
        };
        memberMap.set(row.guestId, member);
      }
      if (row.eventId !== null) {
        member.eventIds.push(row.eventId);
        eventIds.add(row.eventId);
      }
    }

    const eventRows =
      eventIds.size === 0
        ? []
        : yield* dbQuery(() =>
            db
              .select()
              .from(events)
              .where(inArray(events.id, [...eventIds]))
              .all(),
          );

    const eventList: ClaimResponse["events"] = [];
    for (const e of eventRows) {
      const { palette, malformed } = decodePalette(e.dressCodePalette);
      if (malformed) {
        yield* Effect.logWarning(`malformed dress_code_palette`, { eventId: e.id });
      }
      eventList.push({
        id: e.id,
        name: e.name,
        description: e.description,
        startAt: e.startAt,
        endAt: e.endAt,
        timezone: e.timezone,
        address: e.address ?? null,
        dressCodeDescription: e.dressCodeDescription ?? null,
        dressCodePalette: palette,
        pinterestUrl: safeHttpUrl(e.pinterestUrl),
        mapsUrl: safeHttpUrl(e.mapsUrl),
        sortOrder: e.sortOrder ?? 0,
        imageUrl: eventImageUrl(slug, e.id, e.eventImageKey),
        imageCrop: eventImageCrop(e.eventImageKey, e.eventImageCrop),
      });
    }
    eventList.sort((a, b) => a.sortOrder - b.sortOrder);

    // The image URL's `?v=` tracks the IMAGE version like every other slot's
    // (WT-P-I1), coalescing to `updatedAt` for rows that predate migration 0029.
    const closingVersion = (closing?.imagesUpdatedAt ?? closing?.updatedAt)?.getTime() ?? 0;
    return {
      familyId: family.id,
      publicId: family.publicId,
      familyName: family.familyName,
      preview: family.kind === "host",
      members: Array.from(memberMap.values()),
      events: eventList,
      rsvps: rsvpRows,
      // Resolved server-side so the banner the guest reads and the 403 the
      // write path returns are computed by the same function — the client
      // never turns the date into an instant itself.
      rsvpDeadline: resolveRsvpDeadline(
        wedding?.rsvpDeadline,
        wedding?.rsvpDeadlineTimezone,
        new Date(),
      ),
      closing: {
        message: closing?.message ?? null,
        imageUrl: closing?.imageKey
          ? `/api/invite/${encodeURIComponent(slug)}/image/footer?v=${closingVersion}`
          : null,
        // Only surface a rectangle when there is an image to crop; `decodeCrop`
        // drops a malformed/legacy value so a bad rect never reaches a style.
        imageCrop: closing?.imageKey ? decodeCrop(closing.imageCrop) : null,
      },
    };
  }).pipe(Effect.withSpan("cire.claim.buildResponse"));
}

export const claimService = {
  lookup(publicId: string): Effect.Effect<ClaimResponse, InvalidCredentials, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [family] = yield* dbQuery(() =>
        db.select().from(families).where(eq(families.publicId, publicId)).all(),
      );
      if (!family) return yield* Effect.fail(new InvalidCredentials());

      // A deactivated family (organiser cut off a withdrawn invite) is rejected
      // with the SAME generic invalid-credentials failure the unknown-code path
      // above returns — deliberately indistinguishable so the response never
      // reveals that the code exists-but-is-deactivated (enumeration / oracle
      // defence). Host-preview families (`kind === "host"`) are never
      // deactivated by the organiser route, so this only ever fires for a real
      // withdrawn guest invite. Reactivating clears `deactivatedAt` → the code
      // claims normally again.
      if (family.deactivatedAt !== null) return yield* Effect.fail(new InvalidCredentials());

      // Record the FIRST real guest open of this invite. Best-effort and
      // idempotent: only a guest family that has never been opened on its
      // CURRENT code gets a timestamp, and it's never overwritten — so the value
      // reflects first contact and we avoid a write on every page load / re-claim.
      //  - Host-preview families (`kind === "host"`) are the organiser's own
      //    preview, so they must NOT count as a guest opening the invite.
      //  - A write failure is swallowed (logged, no familyId/code/PII): the guest
      //    still gets their invite even if the dashboard signal is missed.
      // The guarded UPDATE (`first_opened_at IS NULL`) makes the once-only write
      // safe even under concurrent claims of the same code.
      if (family.kind === "guest" && family.firstOpenedAt === null) {
        const openedAt = new Date();
        yield* Effect.tryPromise(() =>
          Promise.resolve(
            db
              .update(families)
              .set({ firstOpenedAt: openedAt, updatedAt: openedAt })
              .where(and(eq(families.id, family.id), isNull(families.firstOpenedAt)))
              .run(),
          ),
        ).pipe(
          Effect.tap(() => Effect.sync(() => metricInviteOpened("ok"))),
          Effect.catchAll(() =>
            Effect.sync(() => metricInviteOpened("error")).pipe(
              Effect.zipRight(
                Effect.logError("invite first-open write failed", { familyId: family.id }),
              ),
            ),
          ),
        );
      }

      return yield* buildClaimResponse(family);
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricClaimAttempt("ok"))),
      Effect.tapError(() => Effect.sync(() => metricClaimAttempt("invalid_credentials"))),
      measureClaimLookup,
      Effect.withSpan("cire.claim.lookup"),
    );
  },

  /**
   * Re-read the invite for a household that ALREADY proved membership — the
   * `GET /api/claim/session` restore path, keyed on the `familyId` that
   * `sessionAuth` derived from the `cire_session` cookie.
   *
   * Deliberately NOT a second credential surface: no claim code is accepted
   * here, the caller cannot name a family, and the id comes only from a session
   * this API minted. It returns exactly what `lookup` returns, because it is the
   * same household looking at the same invite a second time.
   *
   * Two differences from `lookup`, both intentional:
   *  - **No first-open write.** A restore is by definition not first contact;
   *    the claim that minted this session already stamped `first_opened_at`, so
   *    writing here would only add a per-page-load write for no signal.
   *  - **Deactivation is re-checked.** Defence in depth, not a hole being
   *    closed: `familyDeactivate` already deletes the family's live sessions in
   *    the same commit as it sets `deactivated_at`, so a withdrawn invite's
   *    cookie should never validate here at all. This is the belt to that
   *    braces — if a session ever survives (a partial write, a future code path
   *    that sets the marker without the revoke), the restore still refuses.
   *    Same generic `InvalidCredentials` as `lookup`, so it is not an oracle.
   */
  restore(familyId: string): Effect.Effect<ClaimResponse, InvalidCredentials, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [family] = yield* dbQuery(() =>
        db.select().from(families).where(eq(families.id, familyId)).all(),
      );
      // A session whose family row is gone (deleted wedding / guest) is as good
      // as no session — fail rather than 500.
      if (!family) return yield* Effect.fail(new InvalidCredentials());
      if (family.deactivatedAt !== null) return yield* Effect.fail(new InvalidCredentials());

      return yield* buildClaimResponse(family);
    }).pipe(measureClaimLookup, Effect.withSpan("cire.claim.restore"));
  },

  /** All events for one wedding (organiser view). weddingId is required —
   * an unscoped variant would be a cross-tenant leak waiting to happen. */
  listEvents(weddingId: string): Effect.Effect<
    {
      id: string;
      name: string;
      slug: string;
      sortOrder: number;
      startAt: string;
      endAt: string;
      timezone: string;
      address: string | null;
      description: string;
      dressCodeDescription: string | null;
      dressCodePalette: readonly DressSwatch[] | null;
      pinterestUrl: string | null;
      mapsUrl: string | null;
      imageUrl: string | null;
      imageCrop: ImageCrop | null;
    }[],
    never,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // The wedding slug scopes the first-party event-image paths — distinct from
      // `events.slug` (the per-event slug). Resolved once for the whole list.
      const [wedding] = yield* dbQuery(() =>
        db.select({ slug: weddings.slug }).from(weddings).where(eq(weddings.id, weddingId)).all(),
      );
      const weddingSlug = wedding?.slug ?? weddingId;
      const rows = yield* dbQuery(() =>
        db
          .select()
          .from(events)
          .where(eq(events.weddingId, weddingId))
          .orderBy(asc(events.sortOrder))
          .all(),
      );
      return rows.map((row) => {
        const { palette } = decodePalette(row.dressCodePalette);
        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          sortOrder: row.sortOrder,
          startAt: row.startAt,
          endAt: row.endAt,
          timezone: row.timezone,
          address: row.address,
          description: row.description,
          dressCodeDescription: row.dressCodeDescription,
          dressCodePalette: palette,
          pinterestUrl: safeHttpUrl(row.pinterestUrl),
          mapsUrl: safeHttpUrl(row.mapsUrl),
          imageUrl: eventImageUrl(weddingSlug, row.id, row.eventImageKey),
          imageCrop: eventImageCrop(row.eventImageKey, row.eventImageCrop),
        };
      });
    }).pipe(Effect.withSpan("cire.claim.listEvents"));
  },

  /** All guests for one wedding (organiser view). weddingId is required —
   * an unscoped variant would be a cross-tenant leak waiting to happen. */
  getAllGuests(weddingId: string): Effect.Effect<OrganiserGuestRow[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const rows = yield* dbQuery(() =>
        db
          .select({
            guestId: guests.id,
            familyId: families.id,
            firstName: guests.firstName,
            lastName: guests.lastName,
            nickname: guests.nickname,
            publicId: families.publicId,
            familyName: families.familyName,
            codeSharedAt: families.codeSharedAt,
            firstOpenedAt: families.firstOpenedAt,
            deactivatedAt: families.deactivatedAt,
            eventId: guestEvents.eventId,
          })
          .from(guests)
          .innerJoin(families, eq(guests.familyId, families.id))
          .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
          // Exclude the synthetic host preview family — it must never appear in
          // the organiser's real guest roster or counts.
          .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
          .orderBy(asc(guests.sortOrder))
          .all(),
      );

      const byGuest = new Map<
        string,
        { -readonly [K in keyof OrganiserGuestRow]: OrganiserGuestRow[K] }
      >();
      for (const row of rows) {
        let entry = byGuest.get(row.guestId);
        if (!entry) {
          entry = {
            guestId: row.guestId,
            familyId: row.familyId,
            publicId: row.publicId,
            familyName: row.familyName,
            firstName: row.firstName,
            lastName: row.lastName,
            nickname: row.nickname,
            events: [],
            // Drizzle decodes the `timestamp`-mode column to a `Date | null`;
            // surface epoch-ms (or null) so the JSON wire stays a plain number.
            codeSharedAt: row.codeSharedAt === null ? null : row.codeSharedAt.getTime(),
            // Same encoding for the first real guest open (drives the dashboard's
            // reliable "Opened" status, distinct from the copy-only "Sent").
            firstOpenedAt: row.firstOpenedAt === null ? null : row.firstOpenedAt.getTime(),
            // Same encoding for the deactivation marker — non-null ⇒ the family's
            // code is disabled (a withdrawn invite); drives the muted row + the
            // Reactivate toggle in the organiser guest table.
            deactivatedAt: row.deactivatedAt === null ? null : row.deactivatedAt.getTime(),
          };
          byGuest.set(row.guestId, entry);
        }
        if (row.eventId !== null) entry.events.push(row.eventId);
      }
      return Array.from(byGuest.values());
    }).pipe(Effect.withSpan("cire.claim.getAllGuests"));
  },

  /**
   * All HOUSEHOLDS for one wedding (organiser view), including ones that hold no
   * guests — see {@link OrganiserHouseholdRow} for why the guest-shaped read
   * can't answer this. Ordered oldest-first so the editor appends a code-only
   * household in creation order rather than an arbitrary one.
   */
  getAllHouseholds(weddingId: string): Effect.Effect<OrganiserHouseholdRow[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // LEFT JOIN so a guest-less household still yields a row, GROUP BY so that
      // is the ONLY row it yields. Counting in SQL rather than fanning the join
      // out one row per guest and summing in JS keeps this read's cost a function
      // of HOUSEHOLDS — what a household-shaped read should scale on — instead of
      // guests; `guests_family_id_sort_idx` serves the aggregate without
      // materialising the guest rows.
      const rows = yield* dbQuery(() =>
        db
          .select({
            familyId: families.id,
            publicId: families.publicId,
            familyName: families.familyName,
            codeSharedAt: families.codeSharedAt,
            firstOpenedAt: families.firstOpenedAt,
            deactivatedAt: families.deactivatedAt,
            guestCount: count(guests.id),
          })
          .from(families)
          .leftJoin(guests, eq(guests.familyId, families.id))
          // Same host-preview exclusion as the guest read: the synthetic family
          // is not part of the organiser's roster and must never round-trip
          // through a draft save.
          .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
          .groupBy(families.id)
          // Creation order, so the editor appends a code-only household where the
          // organiser made it rather than somewhere arbitrary.
          .orderBy(asc(families.createdAt))
          .all(),
      );

      return rows.map((row) => ({
        familyId: row.familyId,
        publicId: row.publicId,
        familyName: row.familyName,
        guestCount: row.guestCount,
        // Same epoch-ms encoding as the guest read: Drizzle decodes these
        // `timestamp`-mode columns to `Date`, and the wire shape is a number.
        codeSharedAt: row.codeSharedAt === null ? null : row.codeSharedAt.getTime(),
        firstOpenedAt: row.firstOpenedAt === null ? null : row.firstOpenedAt.getTime(),
        deactivatedAt: row.deactivatedAt === null ? null : row.deactivatedAt.getTime(),
      }));
    }).pipe(Effect.withSpan("cire.claim.getAllHouseholds"));
  },
};
