import { type Db, DbLive } from "@osn/db/service";
import { type ChangeNoticeData, EmailService, makeLogEmailLive } from "@shared/email";
import { type Duration, Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { refuseWithoutBearerSecret } from "../lib/bearer-secret";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import {
  type ChangeNotice,
  NOTICE_ID_PATTERN,
  noticeDigest,
  parseChangeNotices,
  takesEffectSeconds,
} from "../services/change-notice-registry";
import {
  CHANGE_NOTICE_BATCH_LIMIT,
  type ChangeNoticeBatchOutcome,
  changeNoticeCounts,
  sendChangeNoticeBatch,
} from "../services/change-notices";

/** A shorter secret is treated as none: the route stays off. */
export const CHANGE_NOTICE_SECRET_MIN_LENGTH = 32;

/** How long one provider call may take before its outcome counts as unknown. */
const BATCH_TIMEOUT: Duration.Input = "20 seconds";

export interface ChangeNoticeRouteConfig {
  /** `OSN_CHANGE_NOTICE_SECRET`. Unset or under 32 characters, every call answers 501. */
  readonly secret: string | undefined;
  /** The parsed JSON of the registry file (`services/change-notices.json`). */
  readonly registry: unknown;
  /** The app's origin; a notice links to its page there. */
  readonly appUrl: string;
  /** The identity instance's name, which every account email carries. */
  readonly instanceName: string;
}

export interface ChangeNoticeRouteOptions {
  /** Unix seconds. */
  readonly now?: () => number;
  readonly batchTimeout?: Duration.Input;
  readonly newKey?: (noticeId: string) => string;
}

/** What the route answers a live call: a status, and a body of counts and fixed tokens. */
interface ChangeNoticeAnswer {
  readonly status: number;
  readonly body: Readonly<Record<string, boolean | number | string>>;
}

/** The answer for each outcome of a live call. */
function answerFor(outcome: ChangeNoticeBatchOutcome): ChangeNoticeAnswer {
  switch (outcome.kind) {
    case "finished":
      return {
        status: 200,
        body: {
          ok: true,
          finished: true,
          sent: 0,
          failed: 0,
          sentSoFar: outcome.sentSoFar,
          failedSoFar: outcome.failedSoFar,
        },
      };
    case "sent":
      return {
        status: 200,
        body: {
          ok: true,
          finished: false,
          sent: outcome.sent,
          failed: outcome.failed,
          sentSoFar: outcome.sentSoFar,
          failedSoFar: outcome.failedSoFar,
        },
      };
    case "busy":
      return { status: 409, body: { error: "busy" } };
    case "unconfirmed":
      return { status: 409, body: { error: "unconfirmed_batch", unconfirmed: outcome.count } };
    case "pending_exceeds_limit":
      return { status: 409, body: { error: "pending_exceeds_limit", pending: outcome.count } };
    case "rate_limited":
      return { status: 429, body: { error: "rate_limited" } };
    case "refused":
      return { status: 502, body: { error: "refused" } };
    case "unknown":
      return { status: 503, body: { error: "unknown_outcome" } };
  }
}

/**
 * `POST /internal/change-notices/:noticeId/send`: the operator's run that
 * mails a change notice to every account, one batch of at most 100 a call
 * (`services/change-notices.ts` holds the rules). Body: `dryRun` (counts
 * only, writes and sends nothing), `expect` (the SHA-256 of the notice's words
 * the approver saw), `limit` (the most this call may send) and
 * `resendUnconfirmed` (send a batch the route would not guess about again,
 * under a new key).
 *
 * Refusals, in order, before anything is read or written: Elysia's schema
 * (422); the secret (501 off, 401); the registry (500 `bad_registry`, 404
 * `unknown_notice`); the words (409 `notice_changed`); a transport without
 * keyed batches (501 `no_batch_transport`). Every answer holds counts and
 * fixed tokens only, never an address or an account id.
 */
export function createChangeNoticeRoutes(
  config: ChangeNoticeRouteConfig,
  dbAndEmailLayer: Layer.Layer<Db | EmailService> = Layer.merge(DbLive, makeLogEmailLive().layer),
  loggerLayer: Layer.Layer<never> = Layer.empty,
  runtime?: AppRuntime,
  options: ChangeNoticeRouteOptions = {},
) {
  const { run } = makeAppRunner(runtime, Layer.merge(dbAndEmailLayer, loggerLayer));
  let notices: ReadonlyMap<string, ChangeNotice> | null = null;
  try {
    notices = parseChangeNotices(config.registry);
  } catch {
    notices = null;
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const newKey =
    options.newKey ?? ((noticeId: string) => `change-notice/${noticeId}/${crypto.randomUUID()}`);
  const hasKeyedBatch = Effect.gen(function* () {
    const email = yield* EmailService;
    return email.sendKeyedBatch !== undefined;
  });

  return new Elysia({ prefix: "/internal/change-notices" }).post(
    "/:noticeId/send",
    async ({ params, body, headers, set }) => {
      set.headers["cache-control"] = "no-store";
      const refused = refuseWithoutBearerSecret(
        config.secret,
        headers.authorization,
        set,
        "Change notices are off on this instance",
        CHANGE_NOTICE_SECRET_MIN_LENGTH,
      );
      if (refused) return refused;
      if (notices === null) {
        await run(Effect.logError("change notice registry does not parse"));
        set.status = 500;
        return { error: "bad_registry" };
      }
      const notice = notices.get(params.noticeId);
      if (notice === undefined) {
        set.status = 404;
        return { error: "unknown_notice" };
      }
      if ((await noticeDigest(notice)) !== body.expect) {
        set.status = 409;
        return { error: "notice_changed" };
      }
      try {
        if (!(await run(hasKeyedBatch))) {
          set.status = 501;
          return { error: "no_batch_transport" };
        }
        if (body.dryRun) {
          const counts = await run(changeNoticeCounts(params.noticeId, now()));
          return { ok: true, dryRun: true, ...counts };
        }
        const data: ChangeNoticeData = {
          instanceName: config.instanceName,
          document: notice.document,
          changes: notice.changes,
          takesEffect: takesEffectSeconds(notice),
          url: `${config.appUrl}${notice.path}`,
        };
        const outcome = await run(
          sendChangeNoticeBatch({
            noticeId: params.noticeId,
            data,
            limit: body.limit ?? CHANGE_NOTICE_BATCH_LIMIT,
            resendUnconfirmed: body.resendUnconfirmed ?? false,
            now: now(),
            timeout: options.batchTimeout ?? BATCH_TIMEOUT,
            newKey: () => newKey(params.noticeId),
          }),
        );
        const answer = answerFor(outcome);
        set.status = answer.status;
        return answer.body;
      } catch {
        await run(
          Effect.logError("change notice call failed").pipe(
            Effect.annotateLogs({ notice_id: params.noticeId }),
          ),
        );
        set.status = 500;
        return { error: "internal" };
      }
    },
    {
      params: t.Object({ noticeId: t.String({ pattern: NOTICE_ID_PATTERN }) }),
      body: t.Object({
        dryRun: t.Boolean(),
        expect: t.String({ pattern: "^[0-9a-f]{64}$" }),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: CHANGE_NOTICE_BATCH_LIMIT })),
        resendUnconfirmed: t.Optional(t.Boolean()),
      }),
    },
  );
}
