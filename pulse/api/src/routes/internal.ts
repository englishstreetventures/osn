import { DbLive, type Db } from "@pulse/db/service";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";

import { requireOsnArc } from "../lib/arc-middleware";
import { DEFAULT_VERIFICATION, type OsnTokenVerification } from "../lib/jwks";
import * as accountErasure from "../services/accountErasure";
import * as accountExport from "../services/accountExport";

const SCOPE_ACCOUNT_ERASE = "account:erase";
const SCOPE_ACCOUNT_EXPORT = "account:export";
const SCOPE_DELETION_PREVIEW = "account:deletion-preview";
const SCOPE_SESSIONS_REVOKE = "account:sessions-revoke";

/**
 * Most profile ids one erasure or export request may name. osn-api sends one
 * account's profiles, five by default, so the cap bounds what a single request
 * can make Pulse read and delete rather than shaping any real request.
 */
export const MAX_ACCOUNT_PROFILE_IDS = 50;

/**
 * Internal pulse-api endpoints, every one called by osn-api over ARC and
 * verified against the keys osn-api publishes (`lib/arc-middleware.ts`):
 * the account deletion's preview, erasure and session end, and the account
 * export.
 */
export const createInternalRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  verification: OsnTokenVerification = DEFAULT_VERIFICATION,
) => {
  // Layer graph built once per factory (convention: see osn/api/src/lib/route-runtime.ts) — not per request.
  const runtime = ManagedRuntime.make(dbLayer);
  // INTERNAL_SERVICE_SECRET gates fetching osn-api's keys (a made-up kid is
  // refused before any fetch). Read per request: on workerd `process.env` is
  // filled only inside a handler.
  const osnArc = () => ({
    osnIssuer: verification.issuer,
    kidSecret: process.env.INTERNAL_SERVICE_SECRET || undefined,
  });
  return (
    new Elysia({ prefix: "/internal" })
      // ------------------------------------------------------------------
      // ARC-gated `/internal/account-deletion-preview` — called by osn-api
      // when the person previews, or asks for, their account's deletion:
      // what Pulse holds that needs an answer (`previewDeletion`).
      // ------------------------------------------------------------------
      .post(
        "/account-deletion-preview",
        async ({ body, headers, set }) => {
          if (
            !(await requireOsnArc(headers.authorization, set, osnArc(), SCOPE_DELETION_PREVIEW))
          ) {
            return { error: "Unauthorized" };
          }
          try {
            const openActions = await runtime.runPromise(
              accountErasure.previewDeletion(body.profileIds, body.deletesAt),
            );
            return { openActions };
          } catch {
            set.status = 500;
            return { error: "internal_error" };
          }
        },
        {
          body: t.Object({
            accountId: t.String({ minLength: 1 }),
            profileIds: t.Array(t.String({ minLength: 1 }), { maxItems: MAX_ACCOUNT_PROFILE_IDS }),
            deletesAt: t.Integer({ minimum: 0 }),
          }),
        },
      )
      // ------------------------------------------------------------------
      // ARC-gated `/internal/account-sessions/revoke` — called by osn-api
      // when the person asks for their account's deletion: ends every Pulse
      // web session of their profiles.
      // ------------------------------------------------------------------
      .post(
        "/account-sessions/revoke",
        async ({ body, headers, set }) => {
          if (!(await requireOsnArc(headers.authorization, set, osnArc(), SCOPE_SESSIONS_REVOKE))) {
            return { error: "Unauthorized" };
          }
          try {
            const revoked = await runtime.runPromise(
              accountErasure.revokeWebSessions(body.profileIds),
            );
            return { revoked };
          } catch {
            set.status = 500;
            return { error: "internal_error" };
          }
        },
        {
          body: t.Object({
            accountId: t.String({ minLength: 1 }),
            profileIds: t.Array(t.String({ minLength: 1 }), { maxItems: MAX_ACCOUNT_PROFILE_IDS }),
          }),
        },
      )
      // ------------------------------------------------------------------
      // ARC-gated `/internal/account-deleted` — called by osn-api once the
      // account's 7-day window has passed, with the person's answers to
      // Pulse's actions. Erases Pulse's data of the profiles and answers what
      // Pulse keeps (`purgeAccount`). `email` is part of the contract for
      // apps that keep data a person may ask about; Pulse neither stores nor
      // logs it.
      // ------------------------------------------------------------------
      .post(
        "/account-deleted",
        async ({ body, headers, set }) => {
          if (!(await requireOsnArc(headers.authorization, set, osnArc(), SCOPE_ACCOUNT_ERASE))) {
            return { error: "Unauthorized" };
          }
          try {
            const result = await runtime.runPromise(
              accountErasure.purgeAccount(body.accountId, body.profileIds, {
                answers: body.choices ?? {},
                deleteEverything: body.deleteEverything ?? false,
              }),
            );
            return { kept: result.kept };
          } catch {
            set.status = 500;
            return { error: "internal_error" };
          }
        },
        {
          body: t.Object({
            accountId: t.String({ minLength: 1 }),
            profileIds: t.Array(t.String({ minLength: 1 }), { maxItems: MAX_ACCOUNT_PROFILE_IDS }),
            choices: t.Optional(
              t.Record(
                t.String({ maxLength: 128 }),
                t.Object({ choice: t.String({ maxLength: 32 }) }),
                { maxProperties: 500 },
              ),
            ),
            deleteEverything: t.Optional(t.Boolean()),
            email: t.Optional(t.String({ maxLength: 320 })),
          }),
        },
      )
      // ------------------------------------------------------------------
      // ARC-gated `/internal/account-export` — called by osn-api when
      // fanning out a DSAR (Art.15) export. Returns this account's
      // Pulse-scoped data as NDJSON (one `{ section, record }` object per
      // line). osn-api streams these through its own export envelope, so no
      // header/terminator lines are emitted here.
      // ------------------------------------------------------------------
      .post(
        "/account-export",
        async ({ body, headers, set }) => {
          if (!(await requireOsnArc(headers.authorization, set, osnArc(), SCOPE_ACCOUNT_EXPORT))) {
            return { error: "Unauthorized" };
          }
          try {
            const lines = await runtime.runPromise(
              accountExport.collectExport(body.profile_ids) as Effect.Effect<
                accountExport.ExportLine[],
                accountExport.PulseExportDbError,
                Db
              >,
            );
            const text = lines.map((line) => JSON.stringify(line)).join("\n");
            // Buffered NDJSON: each line ends in "\n" (including the last),
            // and an empty export yields an empty body (osn-api adds the
            // terminator).
            const responseBody = text.length > 0 ? text + "\n" : "";
            return new Response(responseBody, {
              headers: { "content-type": "application/x-ndjson" },
            });
          } catch {
            set.status = 500;
            return { error: "internal_error" };
          }
        },
        {
          body: t.Object({
            account_id: t.String(),
            profile_ids: t.Array(t.String(), { maxItems: MAX_ACCOUNT_PROFILE_IDS }),
          }),
        },
      )
  );
};
