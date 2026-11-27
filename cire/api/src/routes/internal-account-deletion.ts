/**
 * osn-api's two account-deletion calls (`osn/api/src/services/deletion-apps.ts`
 * holds the contract): what an account's deletion would leave open in cire,
 * and the erasure itself once the account's window has passed. The work is
 * `services/account-erasure.ts`.
 *
 * Authenticated by ARC alone (`lib/osn-arc.ts`): a token osn-api signed for
 * `cire-api`, each call with its own scope. Mounted before the app's CSRF
 * origin guard: a server-to-server POST carries no browser `Origin`. No rate
 * limit, as on Pulse's and Zap's receivers: osn-api's calls are bounded by its
 * own per-run cap and per-person limits, and a refused token costs a decode
 * and at most one cached fetch of a public key set. The body is read by hand
 * after the token is checked, so a refused caller costs no parse.
 *
 * The erasure's one email — to the remaining owners of a wedding whose payout
 * account holder it took — is sent from here, through the hook the service
 * calls as each wedding's batch commits, and after the response where the
 * request has `waitUntil`. A caller of the service that passes no hook mails
 * no one, which is how a replay of recorded erasures after a database restore
 * must call it (englishstreetventures/osn#2541, `services/account-erasure.ts`).
 */
import {
  type DeletionRecord,
  type DeletionRecordStore,
  missingDeletionRecordStore,
} from "@shared/db-utils/deletion-records";
import { Effect, Option, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import {
  erasureOutcome,
  instrumentDeletionRecords,
  settleDeletionRecord,
} from "../lib/deletion-records";
import { osnArcAdmits, OSN_ARC_SCOPES, type CireOsnArc } from "../lib/osn-arc";
import { dispatchNotice, type OwnerNotices } from "../lib/owner-notice-email";
import { metricAccountDeletionErasure, metricAccountDeletionPreview } from "../metrics";
import { runCire } from "../observability";
import { accountErasureService, erasureProgress } from "../services/account-erasure";

/** Most profile ids one call may name, as on Zap's receiver. */
const MAX_PROFILE_IDS = 100;

/** Most answers one erasure call may carry. */
const MAX_CHOICES = 500;

const ProfileId = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^usr_[A-Za-z0-9_]+$/),
);
const ProfileIds = Schema.Array(ProfileId).check(Schema.isMaxLength(MAX_PROFILE_IDS));

const PreviewBody = Schema.Struct({
  profileIds: ProfileIds,
  deletesAt: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 32_503_680_000 }),
  ),
});

const ErasureBody = Schema.Struct({
  accountId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  profileIds: ProfileIds,
  choices: Schema.optional(
    Schema.Record(
      Schema.String.check(Schema.isMaxLength(128)),
      Schema.Struct({ choice: Schema.String.check(Schema.isMaxLength(32)) }),
    ),
  ),
  deleteEverything: Schema.optional(Schema.Boolean),
});

export interface InternalAccountDeletionOptions {
  /** Where osn-api's keys are, and the secret that gates fetching them. */
  readonly osnArc: CireOsnArc;
  /** The organiser portal, where an action's link points. */
  readonly organiserOrigin: string;
  /** Owner mail; absent where the deployment cannot send it, and then none is sent. */
  readonly ownerNotices?: OwnerNotices;
  /**
   * Where each erasure is recorded before it runs, so a restore of this
   * database cannot lose it once osn-api has marked cire done
   * (`lib/deletion-records.ts`). Absent, every erasure answers 503.
   */
  readonly deletionRecords?: DeletionRecordStore;
}

const refused = (set: { status?: number | string }) => {
  set.status = 401;
  return { error: "unauthorized" } as const;
};

const badRequest = (set: { status?: number | string }) => {
  set.status = 400;
  return { error: "invalid_request" } as const;
};

export const createInternalAccountDeletionRoutes = (
  db: Db,
  {
    osnArc,
    organiserOrigin,
    ownerNotices,
    deletionRecords = missingDeletionRecordStore(),
  }: InternalAccountDeletionOptions,
) => {
  const records = instrumentDeletionRecords(deletionRecords);
  return new Elysia({ prefix: "/internal" })
    .post(
      "/account-deletion-preview",
      async ({ request, set }) => {
        if (
          !(await osnArcAdmits(
            request.headers.get("authorization"),
            osnArc,
            OSN_ARC_SCOPES.deletionPreview,
          ))
        ) {
          return refused(set);
        }
        const raw: unknown = await request.json().catch(() => null);
        const body = Schema.decodeUnknownOption(PreviewBody)(raw);
        if (Option.isNone(body)) return badRequest(set);

        const result = await runCire(
          accountErasureService
            .deletionPreview({
              profileIds: body.value.profileIds,
              deletesAt: body.value.deletesAt,
              organiserOrigin,
            })
            .pipe(
              Effect.map((openActions) => ({ ok: true as const, openActions })),
              Effect.catchTag("AccountErasureError", (err) =>
                Effect.logError("account deletion preview failed").pipe(
                  Effect.annotateLogs({ reason: err.reason }),
                  Effect.as({ ok: false as const }),
                ),
              ),
              Effect.provideService(DbService, db),
            ),
        );
        if (!result.ok) {
          metricAccountDeletionPreview("error");
          set.status = 500;
          return { error: "internal_error" };
        }
        metricAccountDeletionPreview("ok");
        return { openActions: result.openActions };
      },
      // Sentinel parse hook: the body is read by hand once the token checks.
      { parse: () => ({}) },
    )
    .post(
      "/account-deleted",
      async ({ request, set }) => {
        if (
          !(await osnArcAdmits(request.headers.get("authorization"), osnArc, OSN_ARC_SCOPES.erase))
        ) {
          return refused(set);
        }
        const raw: unknown = await request.json().catch(() => null);
        const decoded = Schema.decodeUnknownOption(ErasureBody)(raw);
        if (Option.isNone(decoded)) return badRequest(set);
        const body = decoded.value;
        // The answers change nothing cire does (`services/account-erasure.ts`);
        // they are checked against the contract and go no further.
        if (Object.keys(body.choices ?? {}).length > MAX_CHOICES) return badRequest(set);

        // The remaining owners of a wedding whose payout account holder this
        // call takes are told as that wedding's batch commits. The email
        // never fails the call and never touches its record.
        const onPayoutHolderLeft = ownerNotices
          ? (weddingId: string) =>
              dispatchNotice(
                request,
                ownerNotices
                  .payoutHolderErased({ weddingId, erasedProfileIds: body.profileIds })
                  .pipe(Effect.provideService(DbService, db)),
              )
          : undefined;
        // Recorded before anything is erased; a record that cannot be written
        // erases nothing and answers 503, and osn-api calls again on its next
        // pass. Once the call returns, the record says what it did, which is
        // all a replay applies, a failure part way included.
        const erasure = {
          v: 1,
          kind: "account_erased",
          at: Date.now(),
          accountId: body.accountId,
          profileIds: body.profileIds,
        } as const satisfies DeletionRecord;
        const result = await runCire(
          Effect.gen(function* () {
            const written = yield* records.write(erasure);
            const progress = erasureProgress();
            const erased = yield* accountErasureService
              .eraseWithOutcomes(
                { accountId: body.accountId, profileIds: body.profileIds, onPayoutHolderLeft },
                progress,
              )
              .pipe(
                // A failure, a defect or an interruption: what the call did
                // before it stopped, and the batch it had sent.
                Effect.onError(() =>
                  settleDeletionRecord(records, written, {
                    ...erasure,
                    outcome: erasureOutcome(progress, false),
                  }),
                ),
              );
            yield* settleDeletionRecord(records, written, {
              ...erasure,
              outcome: erasureOutcome(progress, erased.result.status === "done"),
            });
            return erased.result;
          }).pipe(
            Effect.catchTag("AccountErasureError", () =>
              Effect.succeed({ status: "error" } as const),
            ),
            Effect.catchTag("DeletionRecordRefused", () =>
              Effect.succeed({ status: "error" } as const),
            ),
            Effect.catchTag("DeletionRecordWriteError", () =>
              Effect.succeed({ status: "not_recorded" } as const),
            ),
            Effect.provideService(DbService, db),
          ),
        );
        if (result.status === "not_recorded") {
          metricAccountDeletionErasure("error");
          set.status = 503;
          return { error: "not_recorded" };
        }
        if (result.status === "error") {
          metricAccountDeletionErasure("error");
          set.status = 500;
          return { error: "internal_error" };
        }
        if (result.status === "not_finished") {
          // osn-api leaves cire's mark pending and calls again on its next pass.
          metricAccountDeletionErasure("not_finished");
          set.status = 503;
          return { error: "not_finished" };
        }
        metricAccountDeletionErasure("done");
        return { kept: result.kept };
      },
      { parse: () => ({}) },
    );
};
