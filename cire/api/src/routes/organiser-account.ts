import { createHash } from "node:crypto";

import {
  type DeletionRecord,
  type DeletionRecordStore,
  missingDeletionRecordStore,
} from "@shared/db-utils/deletion-records";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import {
  buildRemovalCookie,
  clearOrganiserSessionCookie,
  clearRemovalCookie,
  parseRemovalCookie,
} from "../lib/cookie";
import {
  erasureOutcome,
  instrumentDeletionRecords,
  settleDeletionRecord,
} from "../lib/deletion-records";
import { dispatchNotice } from "../lib/owner-notice-email";
import type { OwnerNotices } from "../lib/owner-notice-email";
import { metricAccountRemoval } from "../metrics";
import type { AccountRemovalResult } from "../metrics";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { accountErasureService, erasureProgress } from "../services/account-erasure";
import type { OpenAction } from "../services/account-erasure";
import { accountRemovalService } from "../services/account-removal";
import type { HeldPayoutWedding } from "../services/account-removal";
import type { OsnRemovalBridge } from "../services/osn-bridge";
import type { WeddingSignals } from "../services/realtime";

/**
 * A host removes their Cire data and keeps their Musubi account. Three routes,
 * each behind the organiser session and the per-user limiter:
 *
 * - `POST /api/organiser/account/removal/preview` — what the removal would do:
 *   every wedding the person holds a seat on, which of them they alone own,
 *   and the open actions their answers must cover. Before the person has
 *   confirmed on Musubi, the signed-in profile's seats; after, with the code
 *   Musubi sent them back with, every profile of the account's.
 * - `POST /api/organiser/account/removal/confirmation` — asks osn-api for a
 *   step-up request, bound to a secret this browser's `cire_removal` cookie
 *   holds, which the person confirms on Musubi. Answers the request's id, for
 *   the portal to send the person to Musubi's confirm page.
 * - `DELETE /api/organiser/account` — the removal. It needs the confirmed
 *   request (the cookie, and the code in the body). While a profile of the
 *   account holds a wedding's payout account as one of its owners, it is
 *   refused, naming those weddings and the way on: hand the account over or
 *   disconnect it, then remove. Then it needs an answer of `delete` for each
 *   wedding the person alone owns, or `deleteEverything`; it is refused with
 *   the fresh list otherwise. It then runs the account erasure
 *   with the `host` scope, once: every seat of every profile goes, a wedding
 *   left with no owner is deleted, and the person's organiser sessions end.
 *   Past three owned weddings it answers 202 `not_finished`, and the portal
 *   calls again with the same confirmation, which lasts five minutes. The
 *   other owners of each wedding the person leaves are emailed.
 *
 * Someone holding a stolen organiser cookie can begin a request in their own
 * browser, but the code goes to the browser of whoever confirms on Musubi:
 * neither holds both the cookie's secret and the code.
 */

const PREFIX = "/api/organiser";

/**
 * How long the browser holds the request: osn-api's 10 minutes for a pending
 * one and its 5 for a confirmed one, so the cookie outlasts every request it
 * can still spend.
 */
const REMOVAL_COOKIE_SECONDS = 15 * 60;

/** A request id or secret as made here and by osn-api: base64url. */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

const PreviewBody = Schema.Struct({
  code: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});

const RemoveBody = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /** The person's answer to each open action, by its id; `delete` is the one there is. */
  choices: Schema.optional(
    Schema.Record(Schema.String.check(Schema.isMaxLength(128)), Schema.Literal("delete")),
  ),
  /** Answers every open action `delete`. */
  deleteEverything: Schema.optional(Schema.Boolean),
});

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const randomToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** The request id and secret the removal cookie holds, or null. */
function readRemovalCookie(
  header: string | null,
  secure: boolean,
): { requestId: string; secret: string } | null {
  const value = parseRemovalCookie(header, secure);
  if (!value) return null;
  const [requestId, secret, extra] = value.split(".");
  if (extra !== undefined || !requestId || !secret) return null;
  if (!TOKEN.test(requestId) || !TOKEN.test(secret)) return null;
  return { requestId, secret };
}

/** An open action as the portal needs it: its id, and the wedding it names. */
function wireAction(action: OpenAction) {
  const prefix = "cire:wedding:";
  return {
    id: action.id,
    weddingId: action.id.startsWith(prefix) ? action.id.slice(prefix.length) : null,
  };
}

/** The weddings the account alone owns, as the removal refuses on: the deletion preview's rule. */
const soleOwned = (profileIds: ReadonlyArray<string>, organiserOrigin: string) =>
  accountErasureService.preview({
    profileIds,
    deletesAt: Math.floor(Date.now() / 1000),
    organiserOrigin,
  });

/** What a removal would do, for `profileIds`: the screen's list and the actions to answer. */
const plan = (profileIds: ReadonlyArray<string>, organiserOrigin: string) =>
  Effect.gen(function* () {
    const [listed, actions] = yield* Effect.all(
      [accountRemovalService.seats(profileIds), soleOwned(profileIds, organiserOrigin)],
      { concurrency: "unbounded" },
    );
    return {
      weddings: listed.seats,
      more: listed.more,
      openActions: actions.map(wireAction),
    };
  });

type SetStatus = { status?: number | string };

/**
 * The way on from a refusal for a payout account the person holds, in the
 * words the removal screen can show as they are.
 */
const HOLDS_PAYOUT_ACCOUNT_MESSAGE =
  "You connected the Stripe account that money gifts are paid into on the weddings listed. Before you remove your Cire data, hand money gifts to another owner or disconnect the account in each wedding's Money gifts settings, then remove your data again.";

export interface OrganiserAccountRouteOptions {
  readonly limiter: RateLimiterBackend;
  /** osn-api's step-up request calls; absent (no ARC key), every route answers 503. */
  readonly bridge?: OsnRemovalBridge;
  readonly ownerNotices?: OwnerNotices;
  readonly signals?: WeddingSignals;
  /** The organiser portal, where Musubi sends the person back and the preview's links point. */
  readonly organiserOrigin: string;
  /** Cookie `Secure` flag — set for every https tier. */
  readonly secureCookies: boolean;
  /** Where each removal is recorded before it runs; absent, every removal answers 503. */
  readonly deletionRecords?: DeletionRecordStore;
}

export const createOrganiserAccountRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  options: OrganiserAccountRouteOptions,
) => {
  const { bridge, organiserOrigin, secureCookies } = options;
  const origin = organiserOrigin.replace(/\/+$/, "");
  const returnTo = `${origin}/#/remove-data`;
  const records = instrumentDeletionRecords(
    options.deletionRecords ?? missingDeletionRecordStore(),
  );

  const unavailable = (set: SetStatus) => {
    set.status = 503;
    return { error: "unavailable" };
  };
  const counted = <A>(result: AccountRemovalResult, answer: A): A => {
    metricAccountRemoval(result);
    return answer;
  };
  /**
   * The removal refused while the person holds a payout account: the weddings
   * by id and name, which they see as one of its owners, and the way on.
   * Logged with no wedding, profile or name.
   */
  const holdsRefusal = (set: SetStatus, held: ReadonlyArray<HeldPayoutWedding>) =>
    Effect.logInfo("account removal refused: holds payout account").pipe(
      Effect.andThen(
        Effect.sync(() => {
          set.status = 409;
          return counted("holds_payout_account", {
            error: "holds_payout_account",
            message: HOLDS_PAYOUT_ACCOUNT_MESSAGE,
            weddings: held,
          });
        }),
      ),
    );

  /**
   * The account's profiles from a confirmed request, or why there are none:
   * `refused` when the cookie, the code or osn-api's answer does not hold,
   * `unavailable` when osn-api could not be asked.
   */
  const confirmedProfiles = async (
    osnProfileId: string,
    cookieHeader: string | null,
    code: string | undefined,
  ): Promise<
    | { readonly ok: true; readonly accountId: string; readonly profileIds: string[] }
    | { readonly ok: false; readonly reason: "refused" | "unavailable" }
  > => {
    const held = readRemovalCookie(cookieHeader, secureCookies);
    if (!held || !code || !TOKEN.test(code)) return { ok: false, reason: "refused" };
    if (!bridge) return { ok: false, reason: "unavailable" };
    try {
      // The cross-check, cire's own lookup of the account behind the
      // signed-in profile, asked beside osn-api's verify of the request.
      const [verified, own] = await Promise.all([
        bridge.verify({
          profileId: osnProfileId,
          requestId: held.requestId,
          binding: sha256Hex(held.secret),
          code,
        }),
        bridge.resolveAccount(osnProfileId),
      ]);
      if (!verified.ok) return { ok: false, reason: "refused" };
      if (!own.ok || own.accountId !== verified.accountId) {
        await runCire(Effect.logWarning("account removal: confirmed account is not the profile's"));
        return { ok: false, reason: "refused" };
      }
      return { ok: true, accountId: verified.accountId, profileIds: verified.profileIds };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  };

  return new Elysia({ prefix: PREFIX })
    .use(osnAuth(osnAuthOptions))
    .use(rateLimitMiddlewareByUser(options.limiter))
    .post(
      "/account/removal/preview",
      async ({ osnProfileId, request, set }) => {
        if (!osnProfileId) {
          set.status = 500;
          return { error: "Internal error" };
        }
        const raw: unknown = await request.json().catch(() => ({}));
        const decoded = Schema.decodeUnknownOption(PreviewBody)(raw ?? {});
        if (decoded._tag === "None") {
          set.status = 400;
          return { error: "invalid_body" };
        }
        let profileIds = [osnProfileId];
        let confirmed = false;
        if (decoded.value.code !== undefined) {
          const found = await confirmedProfiles(
            osnProfileId,
            request.headers.get("cookie"),
            decoded.value.code,
          );
          if (!found.ok && found.reason === "unavailable") return unavailable(set);
          if (found.ok) {
            profileIds = found.profileIds;
            confirmed = true;
          }
        }
        return runCire(
          plan(profileIds, origin).pipe(
            Effect.provideService(DbService, db),
            Effect.map(({ weddings, more, openActions }) => ({
              weddings,
              more,
              openActions,
              confirmed,
            })),
            Effect.withSpan("cire.account_removal.preview"),
            Effect.catch(() =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Internal error" };
              }),
            ),
            Effect.catchDefect(() =>
              Effect.sync(() => {
                set.status = 500;
                return { error: "Internal error" };
              }),
            ),
          ),
        );
      },
      { parse: () => ({}) },
    )
    .post(
      "/account/removal/confirmation",
      async ({ osnProfileId, set }) => {
        if (!osnProfileId) {
          set.status = 500;
          return { error: "Internal error" };
        }
        if (!bridge) return unavailable(set);
        const secret = randomToken();
        try {
          const begun = await runCire(
            Effect.promise(() =>
              bridge.begin({ profileId: osnProfileId, binding: sha256Hex(secret), returnTo }),
            ).pipe(Effect.withSpan("cire.account_removal.confirm")),
          );
          if (!begun.ok) {
            // `not_found`: osn-api knows no live account behind the profile
            // (its deletion is pending); `refused`: osn-api will not send the
            // person back to this portal, a setting out of step.
            if (begun.reason === "refused") {
              await runCire(Effect.logError("account removal: osn-api refused the return address"));
              return unavailable(set);
            }
            set.status = 409;
            return { error: "account_unavailable" };
          }
          if (!TOKEN.test(begun.requestId)) return unavailable(set);
          set.headers["set-cookie"] = buildRemovalCookie(`${begun.requestId}.${secret}`, {
            secure: secureCookies,
            maxAgeSeconds: REMOVAL_COOKIE_SECONDS,
          });
          return { requestId: begun.requestId };
        } catch {
          return unavailable(set);
        }
      },
      { parse: () => ({}) },
    )
    .delete(
      "/account",
      async ({ osnProfileId, request, set }) => {
        if (!osnProfileId) {
          set.status = 500;
          return { error: "Internal error" };
        }
        const raw: unknown = await request.json().catch(() => null);
        const decoded = Schema.decodeUnknownOption(RemoveBody)(raw);
        if (decoded._tag === "None") {
          set.status = 400;
          return { error: "invalid_body" };
        }
        const body = decoded.value;

        // Before anything is read: a removal the person has not confirmed on
        // Musubi, from this browser, goes no further.
        const found = await confirmedProfiles(
          osnProfileId,
          request.headers.get("cookie"),
          body.code,
        );
        if (!found.ok) {
          if (found.reason === "unavailable") return counted("unavailable", unavailable(set));
          set.status = 403;
          return counted("confirmation_required", { error: "confirmation_required" });
        }
        const { accountId, profileIds } = found;

        return runCire(
          Effect.gen(function* () {
            // A wedding whose payout account a profile of the account holds,
            // as one of its owners beside another, is handed over first: the
            // owner chose to refuse the removal until then. Ahead of the
            // answers, since the hand-over is done outside this screen.
            const held = yield* accountRemovalService.payoutHolds(profileIds);
            if (held.length > 0) return yield* holdsRefusal(set, held);

            // Every wedding the account alone owns needs its answer, on the
            // rows as they stand now, over every profile of the account. The
            // full list is read only for the refusal, which shows it.
            const actions = yield* soleOwned(profileIds, origin);
            const unanswered = actions.filter(
              (action) => !body.deleteEverything && body.choices?.[action.id] !== "delete",
            );
            if (unanswered.length > 0) {
              const current = yield* plan(profileIds, origin);
              set.status = 409;
              return counted("open_actions", {
                error: "open_actions",
                openActions: current.openActions,
                weddings: current.weddings,
                more: current.more,
              });
            }
            // Accepted: recorded outside the database before anything is
            // erased, or refused with nothing erased (lib/deletion-records.ts).
            const removal = {
              v: 1,
              kind: "organiser_data_removed",
              at: Date.now(),
              accountId,
              profileIds,
              deleteEverything: body.deleteEverything === true,
              deleteActions: actions.map((action) => action.id),
            } as const satisfies DeletionRecord;
            const recorded = yield* records
              .write(removal)
              .pipe(Effect.catchTag("DeletionRecordWriteError", () => Effect.succeed(null)));
            if (!recorded) {
              set.status = 503;
              return counted("error", { error: "deletion_not_recorded" });
            }

            // A holder's owner seat the erasure's own writes kept (an account
            // connected since the read above) answers `not_finished`: the
            // portal calls again, and that call is refused by the read.
            // The record then says what this call did, which is all a replay
            // applies, a failure part way included: a call the payout guard
            // stopped before it removed a seat did nothing, and the portal's
            // next call is refused, so its record goes; any other carries its
            // outcome.
            const progress = erasureProgress();
            const erased = yield* accountErasureService
              .eraseWithOutcomes({ accountId, profileIds, scope: "host" }, progress)
              .pipe(
                // A failure, a defect or an interruption: what the call did
                // before it stopped, and the batch it had sent.
                Effect.onError(() =>
                  settleDeletionRecord(records, recorded, {
                    ...removal,
                    outcome: erasureOutcome(progress, false),
                  }),
                ),
              );
            const { result, owned, lowerSeatWeddings, payoutHeld } = erased;
            yield* settleDeletionRecord(
              records,
              recorded,
              payoutHeld.length > 0 && owned.length === 0
                ? null
                : { ...removal, outcome: erasureOutcome(progress, result.status === "done") },
            );

            // The owners who remain on each wedding the person left are told,
            // naming the profile that held the seat there and no other, so no
            // notice says two profiles are one person.
            if (options.ownerNotices) {
              for (const { weddingId, outcome, leavers } of owned) {
                if (outcome !== "seat_removed") continue;
                for (const leaver of leavers) {
                  yield* dispatchNotice(
                    request,
                    options.ownerNotices
                      .ownerLeft({ weddingId, leaverOsnProfileId: leaver })
                      .pipe(Effect.provideService(DbService, db)),
                  );
                }
              }
            }
            // Each wedding a seat went from: its open tabs re-read their
            // members, and the person's own sockets close, except where the
            // erasure kept a payout holder's seat: the holder still sits there.
            if (options.signals) {
              const touched = new Set([...owned.map((o) => o.weddingId), ...lowerSeatWeddings]);
              for (const weddingId of touched) {
                yield* options.signals.membersChanged(
                  weddingId,
                  request,
                  payoutHeld.includes(weddingId) ? [] : profileIds,
                );
              }
            }

            if (result.status === "not_finished") {
              set.status = 202;
              return counted("not_finished", { status: "not_finished" as const });
            }
            // Every organiser session of the account is gone; the browser's
            // cookies go with them. One `Set-Cookie` per cookie, which only a
            // built `Response` can carry.
            const headers = new Headers({ "content-type": "application/json" });
            headers.append("set-cookie", clearOrganiserSessionCookie({ secure: secureCookies }));
            headers.append("set-cookie", clearRemovalCookie({ secure: secureCookies }));
            return counted(
              "done",
              new Response(JSON.stringify({ status: "done" }), { status: 200, headers }),
            );
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.withSpan("cire.account_removal.remove"),
            Effect.catch((err) =>
              Effect.logError("account removal failed").pipe(
                Effect.annotateLogs({ tag: err._tag }),
                Effect.andThen(
                  Effect.sync(() => {
                    set.status = 500;
                    return counted("error", { error: "Internal error" });
                  }),
                ),
              ),
            ),
            Effect.catchDefect(() =>
              Effect.sync(() => {
                set.status = 500;
                return counted("error", { error: "Internal error" });
              }),
            ),
          ),
        );
      },
      { parse: () => ({}) },
    );
};
