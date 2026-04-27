import { DbLive, type Db } from "@zap/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { verifyInternalBearer } from "../lib/internal-auth";
import {
  MAX_EXPORT_PROFILE_IDS,
  resolveDbHandle,
  streamAccountExport,
  type ZapExportLine,
} from "../services/accountExport";

/**
 * Internal Zap endpoint that streams an account holder's Zap-owned data
 * (chat membership only — message ciphertext is intentionally excluded;
 * see services/accountExport.ts for rationale) as part of the OSN-
 * orchestrated DSAR export (C-H1, GDPR Art. 15 + Art. 20).
 *
 * Wire format: NDJSON. The first line is a header
 * (`{"source":"zap-api","profileCount":N}`); subsequent lines are
 * `{"section":"zap.chats","row":{...}}` and one
 * `{"section":"zap.chats_advisory","row":{...}}` advisory line; final
 * line is `{"end":true}`. The orchestrator wraps these into the outer
 * NDJSON envelope verbatim.
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

      const db = await Effect.runPromise(resolveDbHandle().pipe(Effect.provide(dbLayer)));

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const writeLine = (obj: unknown) =>
            controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));

          try {
            writeLine({ source: "zap-api", profileCount: profileIds.length });
            for await (const line of streamAccountExport(db, profileIds)) {
              writeLine(line);
            }
            writeLine({ end: true });
          } catch (err) {
            writeLine({ degraded: "zap", reason: (err as Error)?.message ?? "stream_error" });
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

export type AccountExportInternalLine = ZapExportLine | { end: true };
