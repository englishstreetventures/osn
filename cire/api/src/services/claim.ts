import {
  families,
  guests,
  events,
  guestEvents,
  rsvps,
  weddingInviteCustomisations,
  weddings,
} from "@cire/db";
import { parsePresets } from "@cire/dietary";
import { isSafeCssColor } from "@cire/theme";
import { eq, and, asc, count, inArray, ne, isNull } from "drizzle-orm";
import { Effect, Data } from "effect";

import { DbService, dbQuery } from "../db";
import { resolveRsvpDeadline } from "../lib/rsvp-deadline";
import { measureClaimLookup, metricClaimAttempt, metricInviteOpened } from "../metrics";
import type {
  AccountLinkState,
  ClaimResponse,
  OrganiserGuestRow,
  OrganiserHouseholdRow,
  DressSwatch,
} from "../schemas/claim";
import { decodeCrop, type ImageCrop } from "../schemas/invite";
import { accountLinkService } from "./account-link";
import { eventImagePath, versionFromKey } from "./event-image";
import { inviteFaqService } from "./invite-faq";
import { isDietaryConsentCurrent } from "./rsvp";

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
 * One entry of a decoded `dress_code_palette` array. The column is JSON we
 * wrote, but it is still parsed input — the guard names the two fields a swatch
 * must carry and checks them, so nothing else in the stored blob is read.
 */
function isDressSwatch(value: unknown): value is DressSwatch {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "color" in value &&
    typeof value.color === "string"
  );
}

/** The result of {@link decodePalette}: the swatches, plus whether the stored
 * JSON was unusable (so the caller can log the offending event id). */
export interface DecodedPalette {
  palette: readonly DressSwatch[] | null;
  malformed: boolean;
}

/**
 * Decode the JSON-encoded `dress_code_palette` column. Returns `palette: null`
 * + `malformed: true` so the caller can emit a structured log line referencing
 * the offending event id (kept out of this pure helper to preserve testability
 * and avoid threading Effect through every call site). Exported for the events
 * CSV export, which renders the same swatches as text.
 */
export function decodePalette(raw: string | null): DecodedPalette {
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
    // Copied field by field, never pushed whole: an extra key in the stored
    // JSON must not ride out to the guest. A colour off the allow-list is
    // dropped here too, so a row stored before the write paths checked it
    // reaches no renderer, export or editor draft.
    if (isDressSwatch(item) && isSafeCssColor(item.color)) {
      out.push({ name: item.name, color: item.color });
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
 * The household in its sort order, each plus-one moved to sit right after the
 * member who brought them. A plus-one's own `sort_order` is a copy of their
 * inviter's taken when they were named, and a later reorder of the household
 * does not touch it, so placement goes by the link rather than by that number.
 * A plus-one whose inviter is somehow not in the list keeps its place.
 */
export function withPlusOnesAfterInviters<T extends { guestId: string; plusOneOf: string | null }>(
  members: readonly T[],
): T[] {
  const present = new Set(members.map((m) => m.guestId));
  const placed = members.filter((m) => m.plusOneOf === null || !present.has(m.plusOneOf));
  const byInviter = new Map(
    members.flatMap((m) =>
      m.plusOneOf !== null && present.has(m.plusOneOf) ? [[m.plusOneOf, m] as const] : [],
    ),
  );
  return placed.flatMap((m) => {
    const plusOne = byInviter.get(m.guestId);
    return plusOne ? [m, plusOne] : [m];
  });
}

/**
 * The row shape both entry points below resolve before building a response —
 * `lookup` by claim code, `restore` by the session's family id.
 */
type FamilyRow = typeof families.$inferSelect;

/**
 * What the claim payload needs to report the household's account-link state.
 * The route builds it from the request, since both halves come from there.
 */
export interface AccountLinkGate {
  /** Whether linking is offered to this household. Never rejects. */
  enabledFor(familyId: string): Promise<boolean>;
  /** The raw `cire_org_session` token on this request, or null. */
  osnSessionToken: string | null;
}

const LINKING_OFF: AccountLinkState = { enabled: false };

/**
 * How long the payload waits for the account-linking flag. On a warm isolate
 * the flag answers in a microtask; it can take longer only while the flag
 * provider refreshes its payload from GrowthBook (at most once per cache
 * window per isolate, bounded at 5 s by the provider itself). Past this the
 * household is told linking is off for this one response, so a slow flag
 * service can never hold an invite back. The refresh carries on — the route
 * hands the check to the request's `waitUntil` — and serves the requests after
 * it. Chosen, not measured: well above a healthy CDN fetch, well below what a
 * guest would notice as a stalled invite.
 */
export const ACCOUNT_LINK_FLAG_WAIT = "250 millis";

/**
 * The household's account-link state. Always succeeds: the box it draws is
 * optional, so any failure here — the flag slow, a read throwing, the link
 * table missing — reports linking as off for this response rather than
 * failing the invite beside it. Host preview families are never offered it:
 * a host is not a guest seat, and the page never shows the box in preview.
 */
function accountLinkState(
  family: FamilyRow,
  gate: AccountLinkGate | undefined,
): Effect.Effect<AccountLinkState, never, DbService> {
  if (!gate || family.kind === "host") return Effect.succeed(LINKING_OFF);
  return Effect.promise(() => gate.enabledFor(family.id)).pipe(
    Effect.timeoutOrElse({
      duration: ACCOUNT_LINK_FLAG_WAIT,
      orElse: () =>
        Effect.logWarning("account-linking flag timed out; reporting linking off").pipe(
          Effect.as(false),
        ),
    }),
    Effect.flatMap((on): Effect.Effect<AccountLinkState, never, DbService> =>
      on
        ? accountLinkService.householdState(family.id, gate.osnSessionToken)
        : Effect.succeed(LINKING_OFF),
    ),
    // Inside this branch, not around the whole payload: a defect here must
    // never reach the `Effect.all` that joins it to the invite.
    Effect.catchCause(() =>
      Effect.logWarning("account link state unavailable; reporting linking off").pipe(
        Effect.as(LINKING_OFF),
      ),
    ),
  );
}

/**
 * Build the claim payload for an already-resolved household. Shared by
 * `claimService.lookup` (code entry) and `claimService.restore` (an existing
 * `cire_session` re-reading its own invite), so the two can never drift into
 * serving different views of the same household — which matters because this
 * payload is the ONLY delivery point for the events list and the closing
 * section.
 *
 * The caller owns the household credential check, the first-open write and
 * the metrics. The one credential read here is the account-link state's check
 * of whether the caller's OSN sign-in is live, which it reports as a boolean
 * and never acts on.
 *
 * The account-link state runs beside the whole invite build rather than inside
 * its first group of reads, so the events read never waits on the flag.
 */
function buildClaimResponse(
  family: FamilyRow,
  gate: AccountLinkGate | undefined,
): Effect.Effect<ClaimResponse, never, DbService> {
  return Effect.all([buildInvite(family), accountLinkState(family, gate)], {
    concurrency: "unbounded",
  }).pipe(
    Effect.map(([invite, accountLink]) => ({ ...invite, accountLink })),
    Effect.withSpan("cire.claim.buildResponse"),
  );
}

/** Everything in the claim payload except the account-link state. Pure read. */
function buildInvite(
  family: FamilyRow,
): Effect.Effect<Omit<ClaimResponse, "accountLink">, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    // INDEPENDENT reads, each keyed only off the already-resolved `family` row,
    // so they're pipelined together with `Effect.all`: on D1 their
    // round-trips overlap (fewer serial RTTs on the hot path), and on bun:sqlite
    // (tests/local) they resolve in-process so concurrency is a harmless no-op.
    // The events read can't join this group — it depends on the event ids
    // derived from `guestRows` below — so it stays sequential after.
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
    //  (d) the FAQ entries, which read nothing when the FAQ is switched off —
    //      the switch is checked inside that one statement.
    const {
      wedding: [wedding],
      closingRow: [closing],
      guestRows,
      rsvpRows,
      faqEntries,
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
        // household membership, exactly like the events list beside it. The
        // same row carries the FAQ's switch.
        closingRow: dbQuery(() =>
          db
            .select({
              message: weddingInviteCustomisations.footerMessage,
              imageKey: weddingInviteCustomisations.footerImageKey,
              imageCrop: weddingInviteCustomisations.footerImageCrop,
              visible: weddingInviteCustomisations.footerVisible,
              faqVisible: weddingInviteCustomisations.faqVisible,
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
              plusOneAllowed: guests.plusOneAllowed,
              plusOneOf: guests.plusOneOfGuestId,
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
              dietaryPresets: rsvps.dietaryPresets,
              dietaryConsentVersion: rsvps.dietaryConsentVersion,
              consentSource: rsvps.consentSource,
            })
            .from(rsvps)
            .innerJoin(guests, eq(rsvps.guestId, guests.id))
            .where(eq(guests.familyId, family.id))
            .all(),
        ),
        faqEntries: inviteFaqService.listForGuests(family.weddingId),
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
        plusOneAllowed: boolean;
        plusOneOf: string | null;
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
          plusOneAllowed: row.plusOneAllowed,
          plusOneOf: row.plusOneOf,
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

    const eventList: Array<ClaimResponse["events"][number]> = [];
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

    // The closing section's visibility switch (migration 0063); no row reads
    // as on, the column default. Switched off, the section's content is left
    // out of the payload — the guest site would not render it, so its words
    // stay out of the page. The stored content is untouched.
    const closingVisible = closing?.visible ?? true;
    const closingContent = closingVisible ? closing : undefined;
    // The image URL's `?v=` is derived from the closing image's own R2 key
    // (WT-P-I1 / P-I1) — a digest of the key, not the row's `updatedAt` — so
    // bumping the hero or story slot never busts this one, and a byte-neutral
    // crop save (same key) never busts it either.
    const closingImageUrl = closingContent?.imageKey
      ? `/api/invite/${encodeURIComponent(slug)}/image/footer?v=${versionFromKey(closingContent.imageKey)}`
      : null;
    return {
      familyId: family.id,
      publicId: family.publicId,
      familyName: family.familyName,
      preview: family.kind === "host",
      members: withPlusOnesAfterInviters(Array.from(memberMap.values())),
      events: eventList,
      // The stored key list becomes an array at the boundary, and the stored
      // consent record collapses to "may this person's box open ticked?" — the
      // sheet re-lights its picker from the first and seeds its consent boxes
      // from the second. Consent given against superseded wording, or recorded
      // by someone other than the box's own writer, does not count. Whether a
      // row is a plus-one's comes from the members read above.
      rsvps: rsvpRows.map(({ dietaryConsentVersion, consentSource, ...row }) => ({
        ...row,
        dietaryPresets: parsePresets(row.dietaryPresets),
        dietaryConsentCurrent: isDietaryConsentCurrent({
          version: dietaryConsentVersion,
          source: consentSource,
          isPlusOne: (memberMap.get(row.guestId)?.plusOneOf ?? null) !== null,
        }),
      })),
      // Resolved server-side so the banner the guest reads and the 403 the
      // write path returns are computed by the same function — the client
      // never turns the date into an instant itself.
      rsvpDeadline: resolveRsvpDeadline(
        wedding?.rsvpDeadline,
        wedding?.rsvpDeadlineTimezone,
        new Date(),
      ),
      closing: {
        visible: closingVisible,
        message: closingContent?.message ?? null,
        imageUrl: closingImageUrl,
        // Only surface a rectangle when there is an image to crop; `decodeCrop`
        // drops a malformed/legacy value so a bad rect never reaches a style.
        imageCrop: closingContent?.imageKey ? decodeCrop(closingContent.imageCrop) : null,
      },
      // The FAQ's switch (migration 0064); no row reads as on, the column
      // default. `listForGuests` already returns no entries when it is off.
      faq: {
        visible: closing?.faqVisible ?? true,
        entries: faqEntries,
      },
    };
  });
}

export const claimService = {
  /**
   * Resolve a claim code to its household's invite. `gate` supplies the
   * account-link state; without one (service tests, the D1 tier) the payload
   * reports linking as off.
   */
  lookup(
    publicId: string,
    gate?: AccountLinkGate,
  ): Effect.Effect<ClaimResponse, InvalidCredentials, DbService> {
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
          Effect.catch(() =>
            Effect.sync(() => metricInviteOpened("error")).pipe(
              Effect.andThen(
                Effect.logError("invite first-open write failed", { familyId: family.id }),
              ),
            ),
          ),
        );
      }

      return yield* buildClaimResponse(family, gate);
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
   *
   * `gate` works as it does for `lookup`.
   */
  restore(
    familyId: string,
    gate?: AccountLinkGate,
  ): Effect.Effect<ClaimResponse, InvalidCredentials, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [family] = yield* dbQuery(() =>
        db.select().from(families).where(eq(families.id, familyId)).all(),
      );
      // A session whose family row is gone (deleted wedding / guest) is as good
      // as no session — fail rather than 500.
      if (!family) return yield* Effect.fail(new InvalidCredentials());
      if (family.deactivatedAt !== null) return yield* Effect.fail(new InvalidCredentials());

      return yield* buildClaimResponse(family, gate);
    }).pipe(measureClaimLookup, Effect.withSpan("cire.claim.restore"));
  },

  /** All events for one wedding (organiser view). weddingId is required —
   * an unscoped variant would be a cross-tenant leak waiting to happen.
   * `weddingSlug` scopes the first-party event-image paths — distinct from
   * `events.slug`, the per-event slug. The route takes it from the member gate,
   * which has already read the wedding row. */
  listEvents(
    weddingId: string,
    weddingSlug: string,
  ): Effect.Effect<
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
            plusOneAllowed: guests.plusOneAllowed,
            plusOneOf: guests.plusOneOfGuestId,
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
        Omit<{ -readonly [K in keyof OrganiserGuestRow]: OrganiserGuestRow[K] }, "events"> & {
          events: string[];
        }
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
            plusOneAllowed: row.plusOneAllowed,
            plusOneOf: row.plusOneOf,
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
