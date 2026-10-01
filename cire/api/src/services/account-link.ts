import { families, guestAccountLinks, guests } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { AccountLinkMatchResult } from "../metrics";
import { organiserSessionService } from "./organiser-session";
import type { ValidatedOrganiserSession } from "./organiser-session";
import type { OsnAccountResolver } from "./osn-bridge";

/**
 * How long a restore or an RSVP waits for the ARC call that decides whether
 * this browser's sign-in is the account a member is linked to. Past it the
 * answer is `mismatch`, which shows no account and claims no link: the
 * invite is never held up by osn-api. Chosen, not measured: well above a
 * healthy service-to-service call, well below a stalled page.
 */
export const MEMBER_MATCH_RESOLVE_WAIT = "1 second";

/** The requested guest does not belong to the session's family (or is unknown). */
export class GuestNotInFamily extends Data.TaggedError("GuestNotInFamily")<{
  reason: "unknown_guest";
}> {}

/**
 * The guest is a plus-one. Their row was typed in by the member who brought
 * them, not by anyone holding the household's code, so no account may be
 * bound to it: the link would record someone else's seat as the signed-in
 * account's own.
 */
export class PlusOneSeatNotLinkable extends Data.TaggedError("PlusOneSeatNotLinkable") {}

/**
 * The link would violate a uniqueness invariant.
 *
 * AL-S-L2: the conflicting index is deliberately NOT distinguished. Two
 * distinct UNIQUE constraints can fail here — `guest_id` (this invitee already
 * linked an account) and `(family_id, osn_account_id)` (some OSN account is
 * already seated elsewhere in this household). Surfacing them separately let a
 * caller probe sibling-seat membership of their own household (a membership
 * oracle). Both collapse to a single opaque `already_linked` reason so the two
 * cases are indistinguishable end-to-end (same tag → same 409 → same body).
 */
export class AccountLinkConflict extends Data.TaggedError("AccountLinkConflict")<{
  reason: "already_linked";
}> {}

export class AccountLinkWriteError extends Data.TaggedError("AccountLinkWriteError")<{
  op: "insert" | "delete";
  reason: string;
}> {}

export interface CreatedAccountLink {
  guestId: string;
  linkedAt: Date;
}

/**
 * A household's account-link state when linking is offered to it — what the
 * claim and restore responses carry. Never the OSN account id.
 */
export interface HouseholdLinkState {
  enabled: true;
  /** Whether the request carried a live `cire_org_session`. */
  signedIn: boolean;
  linkedGuestIds: string[];
  /**
   * The signed-in musubi account, for the box to show before "Link". Present
   * only when signed in, a member is chosen, and that member is either
   * unlinked or linked to this same account. Never an account or profile id.
   */
  account?: SignedInAccountView;
}

/** The public profile fields of this browser's musubi sign-in. */
export interface SignedInAccountView {
  displayName: string | null;
  handle: string | null;
  /** An `https:` URL, or null. Any other scheme is dropped. */
  avatarUrl: string | null;
  /** True when the chosen member is linked to this account. */
  matchesMember: boolean;
}

/** How this browser's sign-in compares with a member's link. */
export interface MemberMatch {
  result: AccountLinkMatchResult;
  /** The live sign-in on this request, or null. */
  session: ValidatedOrganiserSession | null;
}

/** `raw` when it is an `https:` URL, else null. */
function httpsUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** The live organiser session behind `token`, or null. Never fails. */
function liveSignIn(
  token: string | null,
): Effect.Effect<ValidatedOrganiserSession | null, never, DbService> {
  if (token === null) return Effect.succeed(null);
  return organiserSessionService
    .validate(token)
    .pipe(Effect.catchTag("OrganiserSessionInvalid", () => Effect.succeed(null)));
}

/** Reverse-lookup row for the Pulse feed integration (account → invitations). */
export interface AccountLinkByAccount {
  guestId: string;
  familyId: string;
  weddingId: string;
  linkedAt: Date;
}

/**
 * Detects a SQLite UNIQUE-constraint failure on either account-link index.
 * Exported so the brittle string-matching is pinned by a direct unit test,
 * independent of the SQLite driver's exact error wording (T-S2).
 *
 * AL-S-L2: returns a single opaque `"already_linked"` for BOTH conflicting
 * indexes — `guest_id` (this invitee already linked) and
 * `(family_id, osn_account_id)` (some account already seated in this household).
 * The two are intentionally not distinguished so the caller can't probe
 * sibling-seat membership of their own household.
 */
export function conflictReason(message: string): AccountLinkConflict["reason"] | null {
  if (!message.includes("UNIQUE constraint failed")) return null;
  // Either the `guest_id` UNIQUE or the `(family_id, osn_account_id)` UNIQUE —
  // both collapse to the same opaque reason (membership-oracle defence).
  if (message.includes("osn_account_id") || message.includes("guest_id")) {
    return "already_linked";
  }
  return null;
}

export const accountLinkService = {
  /**
   * Links an invitee (`guestId`, validated to belong to `familyId`) to an OSN
   * account. The `weddingId` is derived from the guest's family — never trusted
   * from the caller — so the denormalised tenant column can't be spoofed.
   *
   * Conflicts (a UNIQUE index violation) are caught from the insert rather than
   * pre-checked, so concurrent links can't race past a check-then-insert gap.
   */
  link(input: {
    familyId: string;
    guestId: string;
    osnAccountId: string;
    osnProfileId: string;
  }): Effect.Effect<
    CreatedAccountLink,
    GuestNotInFamily | PlusOneSeatNotLinkable | AccountLinkConflict | AccountLinkWriteError,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // Guest must exist AND belong to the session's family, and that family
      // must be a guest household: the organiser's host-preview family is not a
      // guest seat, so it is never linkable, even by a request crafted around
      // the box the preview never shows. The join yields the wedding id for the
      // tenant-scope column in the same query.
      const [scope] = yield* dbQuery(() =>
        db
          .select({ weddingId: families.weddingId, plusOneOf: guests.plusOneOfGuestId })
          .from(guests)
          .innerJoin(families, eq(guests.familyId, families.id))
          .where(
            and(
              eq(guests.id, input.guestId),
              eq(guests.familyId, input.familyId),
              eq(families.kind, "guest"),
            ),
          )
          .all(),
      );
      if (!scope) {
        return yield* Effect.fail(new GuestNotInFamily({ reason: "unknown_guest" }));
      }
      if (scope.plusOneOf !== null) return yield* Effect.fail(new PlusOneSeatNotLinkable());

      const now = new Date();
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .insert(guestAccountLinks)
              .values({
                id: `gal_${crypto.randomUUID()}`,
                guestId: input.guestId,
                familyId: input.familyId,
                weddingId: scope.weddingId,
                osnAccountId: input.osnAccountId,
                osnProfileId: input.osnProfileId,
                linkedAt: now,
                updatedAt: now,
              })
              .run(),
          ),
        catch: (e) => {
          const message = String(e);
          const reason = conflictReason(message);
          return reason
            ? new AccountLinkConflict({ reason })
            : new AccountLinkWriteError({ op: "insert", reason: message });
        },
      }).pipe(
        Effect.tapError((err) =>
          err._tag === "AccountLinkConflict"
            ? Effect.logWarning("account link conflict", { reason: err.reason })
            : Effect.logError("account link insert failed", { reason: err.reason }),
        ),
      );

      return { guestId: input.guestId, linkedAt: now };
    }).pipe(Effect.withSpan("cire.accountLink.link"));
  },

  /**
   * The household's linked seats, and whether the caller is signed in to the
   * OSN session a link is made with — the two facts the guest site needs to
   * draw the account-link box without asking for them.
   *
   * `osnSessionToken` is the raw `cire_org_session` value from the request, or
   * null. It is only checked for being live; the answer is one boolean and
   * authorises nothing. An unknown or expired token is `signedIn: false`. Both
   * reads are independent, so they run together.
   */
  householdState(
    familyId: string,
    osnSessionToken: string | null,
    member?: { guestId: string | null; resolveAccountId?: OsnAccountResolver },
  ): Effect.Effect<HouseholdLinkState & { match?: AccountLinkMatchResult }, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { links, session } = yield* Effect.all(
        {
          links: dbQuery(() =>
            db
              .select({
                guestId: guestAccountLinks.guestId,
                osnProfileId: guestAccountLinks.osnProfileId,
                osnAccountId: guestAccountLinks.osnAccountId,
              })
              .from(guestAccountLinks)
              .where(eq(guestAccountLinks.familyId, familyId))
              .all(),
          ),
          session: liveSignIn(osnSessionToken),
        },
        { concurrency: "unbounded" },
      );
      const state: HouseholdLinkState & { match?: AccountLinkMatchResult } = {
        enabled: true as const,
        signedIn: session !== null,
        linkedGuestIds: links.map((l) => l.guestId),
      };
      // Without the member step there is no member to compare against, and
      // the payload keeps the shape it had before it.
      if (!member) return state;
      const memberId = member.guestId;
      if (memberId === null) return state;
      const link = links.find((l) => l.guestId === memberId) ?? null;
      const result = yield* compareSignIn(link, session, member.resolveAccountId);
      state.match = result;
      if (session !== null && (result === "unlinked" || result === "match")) {
        state.account = {
          displayName: session.displayName,
          handle: session.handle,
          avatarUrl: httpsUrl(session.avatarUrl),
          matchesMember: result === "match",
        };
      }
      return state;
    }).pipe(Effect.withSpan("cire.accountLink.householdState"));
  },

  /**
   * How this request's musubi sign-in compares with `memberGuestId`'s link —
   * what the RSVP write stamps as `submitted_via_link`. Never fails: any
   * failure reads as `mismatch`, which claims no link.
   */
  memberMatch(
    memberGuestId: string,
    osnSessionToken: string | null,
    resolveAccountId?: OsnAccountResolver,
  ): Effect.Effect<MemberMatch, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { links, session } = yield* Effect.all(
        {
          links: dbQuery(() =>
            db
              .select({
                guestId: guestAccountLinks.guestId,
                osnProfileId: guestAccountLinks.osnProfileId,
                osnAccountId: guestAccountLinks.osnAccountId,
              })
              .from(guestAccountLinks)
              .where(eq(guestAccountLinks.guestId, memberGuestId))
              .all(),
          ),
          session: liveSignIn(osnSessionToken),
        },
        { concurrency: "unbounded" },
      );
      const result = yield* compareSignIn(links[0] ?? null, session, resolveAccountId);
      return { result, session };
    }).pipe(Effect.withSpan("cire.accountLink.memberMatch"));
  },

  /**
   * Removes an invitee's account link. Scoped to `(familyId, guestId)` so a
   * session can only unlink invitees in its own household. Idempotent: removing
   * a link that isn't there succeeds.
   */
  unlink(input: {
    familyId: string;
    guestId: string;
  }): Effect.Effect<void, AccountLinkWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .delete(guestAccountLinks)
              .where(
                and(
                  eq(guestAccountLinks.familyId, input.familyId),
                  eq(guestAccountLinks.guestId, input.guestId),
                ),
              )
              .run(),
          ),
        catch: (e) => new AccountLinkWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("account link delete failed", { reason: err.reason }),
        ),
      );
    }).pipe(Effect.withSpan("cire.accountLink.unlink"));
  },

  /**
   * Reverse lookup: every invitee linked to an OSN account, across all
   * households/weddings. Feeds the (future) Pulse integration that surfaces a
   * user's invitations. account id is the S2S correlation key and never leaves
   * the server, so this is keyed by it but does not echo it back.
   */
  listByAccount(osnAccountId: string): Effect.Effect<AccountLinkByAccount[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            guestId: guestAccountLinks.guestId,
            familyId: guestAccountLinks.familyId,
            weddingId: guestAccountLinks.weddingId,
            linkedAt: guestAccountLinks.linkedAt,
          })
          .from(guestAccountLinks)
          .where(eq(guestAccountLinks.osnAccountId, osnAccountId))
          .all(),
      );
      return rows;
    }).pipe(Effect.withSpan("cire.accountLink.listByAccount"));
  },
};

/**
 * Compare a member's link with a live sign-in. A match is the same profile, or
 * failing that a profile that resolves over ARC to the link's account — one
 * call, bounded by {@link MEMBER_MATCH_RESOLVE_WAIT}. With no resolver, a
 * failed call or a timeout the answer is `mismatch`.
 */
function compareSignIn(
  link: { osnProfileId: string; osnAccountId: string } | null,
  session: ValidatedOrganiserSession | null,
  resolveAccountId: OsnAccountResolver | undefined,
): Effect.Effect<AccountLinkMatchResult> {
  if (link === null) return Effect.succeed("unlinked");
  if (session === null) return Effect.succeed("signed_out");
  if (session.osnProfileId === link.osnProfileId) return Effect.succeed("match");
  if (!resolveAccountId) return Effect.succeed("mismatch");
  const profileId = session.osnProfileId;
  return Effect.tryPromise(() => resolveAccountId(profileId)).pipe(
    Effect.map((resolution): AccountLinkMatchResult =>
      resolution.ok && resolution.accountId === link.osnAccountId ? "match" : "mismatch",
    ),
    Effect.timeoutOrElse({
      duration: MEMBER_MATCH_RESOLVE_WAIT,
      orElse: () =>
        Effect.logWarning("account match resolve timed out").pipe(
          Effect.as<AccountLinkMatchResult>("mismatch"),
        ),
    }),
    Effect.catch(() =>
      Effect.logWarning("account match resolve failed").pipe(
        Effect.as<AccountLinkMatchResult>("mismatch"),
      ),
    ),
  );
}
