/**
 * osn-api's account-export call (`GET /account/export` fans out to every app
 * in `osn/api/src/services/deletion-apps.ts`): cire's section of a person's
 * export, as NDJSON lines osn-api streams into its own envelope. The work is
 * `services/account-export.ts`.
 *
 * Authenticated by ARC alone (`lib/osn-arc.ts`): a token osn-api signed for
 * `cire-api` with scope `account:export`. Mounted before the app's CSRF origin
 * guard, as the deletion calls are: a server-to-server POST carries no browser
 * `Origin`. No rate limit, as on Pulse's and Zap's receivers: osn-api calls
 * once per export, an export is one a day per account, and a refused token
 * costs a decode and at most one cached fetch of a public key set. The body is
 * read by hand after the token is checked, so a refused caller costs no parse.
 */
import { Effect, Option, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnArcAdmits, OSN_ARC_SCOPES } from "../lib/osn-arc";
import { metricAccountExport } from "../metrics";
import { runCire } from "../observability";
import { accountExportService } from "../services/account-export";

/** Most profile ids one call may name, as on the deletion calls. */
const MAX_PROFILE_IDS = 100;

const ProfileId = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^usr_[A-Za-z0-9_]+$/),
);

/** osn-api's body, in its own field names (`osn/api/src/services/account-export.ts`). */
const ExportBody = Schema.Struct({
  account_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  profile_ids: Schema.Array(ProfileId).check(Schema.isMaxLength(MAX_PROFILE_IDS)),
});

export interface InternalAccountExportOptions {
  /** osn-api's origin, whose published keys sign its tokens (`OSN_ISSUER_URL`). */
  readonly osnIssuer: string;
  /** The organiser portal, where a wedding's download page is. */
  readonly organiserOrigin: string;
}

export const createInternalAccountExportRoutes = (
  db: Db,
  { osnIssuer, organiserOrigin }: InternalAccountExportOptions,
) =>
  new Elysia({ prefix: "/internal" }).post(
    "/account-export",
    async ({ request, set }) => {
      if (
        !(await osnArcAdmits(
          request.headers.get("authorization"),
          osnIssuer,
          OSN_ARC_SCOPES.export,
        ))
      ) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const raw: unknown = await request.json().catch(() => null);
      const body = Schema.decodeUnknownOption(ExportBody)(raw);
      if (Option.isNone(body)) {
        set.status = 400;
        return { error: "invalid_request" };
      }

      const lines = await runCire(
        accountExportService.weddingSeats(body.value.profile_ids, organiserOrigin).pipe(
          Effect.provideService(DbService, db),
          // No id in the line: the profile ids are the person's.
          Effect.catchDefect(() => Effect.logError("account export failed").pipe(Effect.as(null))),
        ),
      );
      if (lines === null) {
        metricAccountExport("error");
        set.status = 500;
        return { error: "internal_error" };
      }
      metricAccountExport("ok");
      return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      });
    },
    // Sentinel parse hook: the body is read by hand once the token checks.
    { parse: () => ({}) },
  );
