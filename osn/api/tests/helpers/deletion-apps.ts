import { deletionJobs } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DeletionApp, DeletionAppsConfig } from "../../src/services/deletion-apps";

/** One call an app stand-in received. */
export interface AppCall {
  readonly app: DeletionApp;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly authorization: string | null;
}

/** What a stand-in answers one call with. */
export type AppAnswer = {
  readonly status?: number;
  readonly body?: unknown;
  readonly delayMs?: number;
};

/**
 * One HTTP server standing in for every app the deletion reaches, each under
 * its own path prefix (`/pulse`, `/zap`), recording every call and answering
 * by `answer`. The default answers keep the contract: a preview with no
 * actions, an erasure that kept nothing, a session end.
 */
export function appStandIns(answer: (call: AppCall) => AppAnswer | undefined = () => undefined): {
  readonly calls: AppCall[];
  readonly config: (overrides?: Partial<DeletionAppsConfig>) => DeletionAppsConfig;
  readonly stop: () => void;
} {
  const calls: AppCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const [, app, ...rest] = url.pathname.split("/");
      const call: AppCall = {
        app: app as DeletionApp,
        path: `/${rest.join("/")}`,
        body: (await request.json()) as Record<string, unknown>,
        authorization: request.headers.get("authorization"),
      };
      calls.push(call);
      const given = answer(call);
      if (given?.delayMs) await new Promise((resolve) => setTimeout(resolve, given.delayMs));
      if (given?.body !== undefined || given?.status !== undefined) {
        return Response.json(given.body ?? {}, { status: given.status ?? 200 });
      }
      if (call.path === "/internal/account-deletion-preview") {
        return Response.json({ openActions: [] });
      }
      if (call.path === "/internal/account-deleted") return Response.json({ kept: [] });
      return Response.json({ ok: true });
    },
  });
  const base = `http://localhost:${server.port}`;
  return {
    calls,
    config: (overrides = {}) => ({
      local: true,
      urls: { pulse: `${base}/pulse`, zap: `${base}/zap` },
      absent: new Set(),
      arc: { kidSecret: "test-internal-secret-of-32-chars!" },
      previewTimeoutMs: 8_000,
      fanoutTimeoutMs: 10_000,
      ...overrides,
    }),
    stop: () => void server.stop(true),
  };
}

/**
 * Marks every app done on `accountId`'s deletion job, as the fan-out does once
 * each app has answered, so a test can go straight to the hard delete.
 */
export const everyAppDone = (accountId: string): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db
        .update(deletionJobs)
        .set({ pulseDoneAt: 1_700_000_000, zapDoneAt: 1_700_000_000 })
        .where(eq(deletionJobs.accountId, accountId)),
    );
  });
