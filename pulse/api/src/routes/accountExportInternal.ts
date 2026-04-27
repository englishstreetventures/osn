import { DbLive, type Db } from "@pulse/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { verifyInternalBearer } from "../lib/internal-auth";
import {
  MAX_EXPORT_PROFILE_IDS,
  resolveDbHandle,
  streamAccountExport,
  type PulseExportLine,
} from "../services/accountExport";

/**
 * Internal Pulse endpoint that streams an account holder's Pulse-owned data
 * as part of the OSN-orchestrated DSAR export (C-H1, GDPR Art. 15 + Art.
 * 20). Authenticated via the shared `INTERNAL_SERVICE_SECRET` bearer
 * token — see `lib/internal-auth.ts` for why this isn't ARC yet.
 *
 * Wire format: NDJSON (`application/x-ndjson`). One JSON object per line:
 *   `{"section":"pulse.rsvps","row":{...}}`
 * with a final terminator line:
 *   `{"end":true}`
 *
 * The orchestrator in osn/api wraps these lines verbatim into the outer
 * bundle envelope (which carries the `version`, full `sections[]`, and
 * `{"end":true,"completedAt":...}` outer terminator) — this endpoint's
 * own `{"end":true}` is a per-bridge sentinel so the bridge can detect
 * a clean close vs a connection drop.
 */
export function createAccountExportInternalRoutes(dbLayer: Layer.Layer<Db> = DbLive) {
  return new Elysia({ prefix: "/account-export/internal" }).post(
    "/",
    async ({ body, headers, set }) => {
      const auth = verifyInternalBearer(headers.authorization);
      if (!auth.ok) {
        set.status = auth.status;
        return { error: auth.error };
      }

      const profileIds = body.profileIds.slice(0, MAX_EXPORT_PROFILE_IDS);

      // Resolve Db once via the Effect runtime, then stream lazily.
      // The Bun sqlite handle is a synchronous in-process resource — safe
      // to use after the Effect lifecycle ends.
      const db = await Effect.runPromise(resolveDbHandle().pipe(Effect.provide(dbLayer)));

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const writeLine = (obj: unknown) =>
            controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));

          try {
            writeLine({ source: "pulse-api", profileCount: profileIds.length });
            for await (const line of streamAccountExport(db, profileIds)) {
              writeLine(line);
            }
            writeLine({ end: true });
          } catch (err) {
            // We've already streamed the start line, so we can't change
            // the HTTP status. Emit a tombstone so the orchestrator's
            // bridge consumer can record `dsar.bridge.outcome=error` and
            // upgrade the bundle decision to `partial`.
            writeLine({ degraded: "pulse", reason: (err as Error)?.message ?? "stream_error" });
          } finally {
            controller.close();
          }
        },
      });

      set.headers["content-type"] = "application/x-ndjson; charset=utf-8";
      set.headers["cache-control"] = "no-store";
      return stream;
    },
    {
      body: t.Object({
        profileIds: t.Array(t.String({ minLength: 1 }), {
          maxItems: MAX_EXPORT_PROFILE_IDS,
        }),
      }),
    },
  );
}

export type AccountExportInternalLine = PulseExportLine | { end: true };
