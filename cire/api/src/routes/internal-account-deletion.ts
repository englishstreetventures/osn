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
 */
import { Effect, Option, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnArcAdmits, OSN_ARC_SCOPES } from "../lib/osn-arc";
import { metricAccountDeletionErasure, metricAccountDeletionPreview } from "../metrics";
import { runCire } from "../observability";
import { accountErasureService } from "../services/account-erasure";

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
  /** osn-api's origin, whose published keys sign its tokens (`OSN_ISSUER_URL`). */
  readonly osnIssuer: string;
  /** The organiser portal, where an action's link points. */
  readonly organiserOrigin: string;
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
  { osnIssuer, organiserOrigin }: InternalAccountDeletionOptions,
) => {
  return new Elysia({ prefix: "/internal" })
    .post(
      "/account-deletion-preview",
      async ({ request, set }) => {
        if (
          !(await osnArcAdmits(
            request.headers.get("authorization"),
            osnIssuer,
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
            .preview({
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
          !(await osnArcAdmits(
            request.headers.get("authorization"),
            osnIssuer,
            OSN_ARC_SCOPES.erase,
          ))
        ) {
          return refused(set);
        }
        const raw: unknown = await request.json().catch(() => null);
        const decoded = Schema.decodeUnknownOption(ErasureBody)(raw);
        if (Option.isNone(decoded)) return badRequest(set);
        const body = decoded.value;
        const choices = body.choices ?? {};
        if (Object.keys(choices).length > MAX_CHOICES) return badRequest(set);

        const result = await runCire(
          accountErasureService
            .erase({
              accountId: body.accountId,
              profileIds: body.profileIds,
              choices,
              deleteEverything: body.deleteEverything ?? false,
            })
            .pipe(
              Effect.catchTag("AccountErasureError", () =>
                Effect.succeed({ status: "error" } as const),
              ),
              Effect.provideService(DbService, db),
            ),
        );
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
