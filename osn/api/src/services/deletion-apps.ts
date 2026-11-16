/**
 * The apps an account deletion reaches, and the contract each implements.
 *
 * Every app is sent every account; nothing checks enrolment. An app takes
 * part through two ARC calls:
 *
 * - `POST /internal/account-deletion-preview`, scope `account:deletion-preview`,
 *   with `{ profileIds, deletesAt }`, answering
 *   `{ openActions: [{ id, kind, label, choices: [{ choice, description,
 *   erasedOn }], defaultChoice, link }] }`: what the app holds that needs an
 *   answer. Every id starts with `<app>:`.
 * - `POST /internal/account-deleted`, scope `account:erase`, with
 *   `{ accountId, profileIds, choices, deleteEverything }` once the window has
 *   passed, and `email` too for an app that receives it
 *   ({@link DeletionAppEntry.receivesEmail}), answering
 *   `{ kept: [{ what, erasedOn, requestUrl }] }`: what the app keeps, until
 *   when, and where to ask about it. A repeat of the call answers the same.
 *   `accountId` keys the app's record of the erasure; no other call carries
 *   it.
 *
 * Adding an app is one more entry in {@link DELETION_APPS}, its `*_done_at`
 * column on `deletion_jobs`, its URL variable, and its host in the stacks.
 */

import { deletionJobs } from "@osn/db/schema";
import type { Db } from "@osn/db/service";
import type { DeletionFanoutService } from "@shared/observability/metrics";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { Data, Effect, Schema } from "effect";

import { arcPostJsonEffect, type OutboundArcConfig } from "../lib/outbound-arc";
import {
  metricAccountDeletionAppPreview,
  metricAccountDeletionAppSessionsEnded,
  safeErrorSummary,
} from "../metrics";

/** An app the deletion reaches. */
export type DeletionApp = DeletionFanoutService;

/** One app's place in the deletion. */
export interface DeletionAppEntry {
  readonly app: DeletionApp;
  /** Its ARC audience. */
  readonly audience: string;
  /** Its `deletion_jobs` mark: positive once the fan-out is done with it. */
  readonly done: AnySQLiteColumn;
  /** The mark's field on a `deletion_jobs` row. */
  readonly doneKey: "pulseDoneAt" | "zapDoneAt";
  /** The URL variable osn-api reads it from. */
  readonly urlVariable: "PULSE_API_URL" | "ZAP_API_URL";
  /** Whether the soft delete ends the person's sessions there. */
  readonly endsSessionsAtSoftDelete: boolean;
  /**
   * Whether the erasure sends the app the account's email address: only an
   * app that keeps data after the erasure which a person may ask about by
   * email needs it to prove a later request.
   */
  readonly receivesEmail: boolean;
}

export const DELETION_APPS: ReadonlyArray<DeletionAppEntry> = [
  {
    app: "pulse",
    audience: "pulse-api",
    done: deletionJobs.pulseDoneAt,
    doneKey: "pulseDoneAt",
    urlVariable: "PULSE_API_URL",
    endsSessionsAtSoftDelete: true,
    receivesEmail: false,
  },
  {
    app: "zap",
    audience: "zap-api",
    done: deletionJobs.zapDoneAt,
    doneKey: "zapDoneAt",
    urlVariable: "ZAP_API_URL",
    endsSessionsAtSoftDelete: false,
    receivesEmail: false,
  },
];

const APP_NAMES: ReadonlySet<string> = new Set(DELETION_APPS.map((entry) => entry.app));

const isDeletionApp = (name: string): name is DeletionApp => APP_NAMES.has(name);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Where each app is on this tier. */
export interface DeletionAppsConfig {
  /** A local run (`OSN_ENV` unset or `local`), where an app with no URL is skipped. */
  readonly local: boolean;
  readonly urls: Readonly<Partial<Record<DeletionApp, string>>>;
  /** Apps this tier does not run (`OSN_DELETION_ABSENT_APPS`): skipped, never called. */
  readonly absent: ReadonlySet<DeletionApp>;
  /** What signing the calls needs. */
  readonly arc: OutboundArcConfig;
  /** How long one app has to answer a preview: its own key fetch may take 5 s. */
  readonly previewTimeoutMs: number;
  /** How long one app has to finish an erasure, or to end the person's sessions. */
  readonly fanoutTimeoutMs: number;
}

/** {@link DeletionAppsConfig.previewTimeoutMs} on every tier. */
const PREVIEW_TIMEOUT_MS = 8_000;

/** {@link DeletionAppsConfig.fanoutTimeoutMs} on every tier. */
const FANOUT_TIMEOUT_MS = 10_000;

/**
 * The deletion's apps when the caller names none: every app skipped, as on a
 * local run with no app running.
 */
export const NO_DELETION_APPS: DeletionAppsConfig = {
  local: true,
  urls: {},
  absent: new Set(),
  arc: { kidSecret: undefined },
  previewTimeoutMs: PREVIEW_TIMEOUT_MS,
  fanoutTimeoutMs: FANOUT_TIMEOUT_MS,
};

/** The variables {@link deletionAppsConfig} reads. */
export interface DeletionAppsEnv {
  readonly OSN_ENV?: string;
  readonly PULSE_API_URL?: string;
  readonly ZAP_API_URL?: string;
  readonly OSN_DELETION_ABSENT_APPS?: string;
  readonly INTERNAL_SERVICE_SECRET?: string;
}

/** A deployment whose deletion settings cannot be right. */
export class DeletionAppsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeletionAppsConfigError";
  }
}

/** Plain HTTP reaches only this machine, where the local and E2E stacks run. */
const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";

/**
 * Whether the deletion may send a token and the person's data to `url`:
 * `https:` anywhere, and `http:` only to a loopback host on a local run.
 */
const isUsableAppUrl = (url: string, local: boolean): boolean => {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" || (local && protocol === "http:" && isLoopbackHost(hostname));
};

/**
 * The deletion's app settings from the deployment's variables, with no
 * fallback address. Throws {@link DeletionAppsConfigError} for a name in
 * `OSN_DELETION_ABSENT_APPS` that is no app, an app both given a URL and
 * declared absent, an app URL that is not `https:` (or, on a local run,
 * `http:` to a loopback host), or a deployed tier without
 * `INTERNAL_SERVICE_SECRET`, whose calls every app would refuse.
 */
export function deletionAppsConfig(env: DeletionAppsEnv): DeletionAppsConfig {
  const local = !env.OSN_ENV || env.OSN_ENV === "local";
  const absent = new Set<DeletionApp>();
  for (const name of (env.OSN_DELETION_ABSENT_APPS ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed === "") continue;
    if (!isDeletionApp(trimmed)) {
      throw new DeletionAppsConfigError(
        `OSN_DELETION_ABSENT_APPS names "${trimmed}", which is not an app the deletion reaches`,
      );
    }
    absent.add(trimmed);
  }
  // Each read by name, so a check of what osn-api reads
  // (musubi/infra/tests/reads.test.ts) sees every one.
  const given = {
    PULSE_API_URL: env.PULSE_API_URL,
    ZAP_API_URL: env.ZAP_API_URL,
  } satisfies Record<DeletionAppEntry["urlVariable"], string | undefined>;
  const urls: Partial<Record<DeletionApp, string>> = {};
  for (const entry of DELETION_APPS) {
    const url = given[entry.urlVariable]?.trim();
    if (!url) continue;
    if (absent.has(entry.app)) {
      throw new DeletionAppsConfigError(
        `${entry.urlVariable} is set but OSN_DELETION_ABSENT_APPS declares ${entry.app} absent`,
      );
    }
    if (!isUsableAppUrl(url, local)) {
      throw new DeletionAppsConfigError(
        `${entry.urlVariable} must be an https: URL${local ? ", or http: to a loopback host" : ""}`,
      );
    }
    urls[entry.app] = url.replace(/\/+$/, "");
  }
  const kidSecret = env.INTERNAL_SERVICE_SECRET || undefined;
  if (!local && !kidSecret) {
    throw new DeletionAppsConfigError(
      "INTERNAL_SERVICE_SECRET must be set: apps refuse osn-api's ARC calls without its key-id MAC",
    );
  }
  return {
    local,
    urls,
    absent,
    arc: { kidSecret },
    previewTimeoutMs: PREVIEW_TIMEOUT_MS,
    fanoutTimeoutMs: FANOUT_TIMEOUT_MS,
  };
}

/** How the deletion reaches one app on this tier. */
export type AppTarget =
  | { readonly kind: "url"; readonly url: string }
  /** The tier does not run the app: nothing to preview or erase there. */
  | { readonly kind: "skip" }
  /** A deployed tier with neither a URL nor a declaration: fail closed. */
  | { readonly kind: "unconfigured" };

export function appTarget(config: DeletionAppsConfig, app: DeletionApp): AppTarget {
  const url = config.urls[app];
  if (url) return { kind: "url", url };
  if (config.absent.has(app) || config.local) return { kind: "skip" };
  return { kind: "unconfigured" };
}

// ---------------------------------------------------------------------------
// The contract's answers
// ---------------------------------------------------------------------------

/** Most open actions one app may answer. */
const MAX_APP_ACTIONS = 200;

/** Most kept items one app may answer. */
const MAX_KEPT_ITEMS = 100;

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

/** Unix seconds, or null when the item has no date. */
const UnixSecondsOrNull = Schema.NullOr(
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 32_503_680_000 })),
);

const HttpsUrlOrNull = Schema.NullOr(
  Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^https:\/\/[^\s]+$/)),
);

const AppChoice = Schema.Struct({
  choice: Text(32),
  description: Text(500),
  erasedOn: UnixSecondsOrNull,
});

const AppOpenActionSchema = Schema.Struct({
  id: Text(128),
  kind: Text(64),
  label: Text(500),
  choices: Schema.Array(AppChoice).check(Schema.isMaxLength(10)),
  defaultChoice: Schema.NullOr(Text(32)),
  link: HttpsUrlOrNull,
});

const PreviewAnswer = Schema.Struct({
  openActions: Schema.Array(AppOpenActionSchema).check(Schema.isMaxLength(MAX_APP_ACTIONS)),
});

const KeptItemSchema = Schema.Struct({
  what: Text(500),
  erasedOn: UnixSecondsOrNull,
  requestUrl: HttpsUrlOrNull,
});

const DeletedAnswer = Schema.Struct({
  kept: Schema.Array(KeptItemSchema).check(Schema.isMaxLength(MAX_KEPT_ITEMS)),
});

/** One thing an app holds that the person may answer before deleting. */
export type AppOpenAction = typeof AppOpenActionSchema.Type;

/** One thing an app keeps after the account is gone. */
export type KeptItem = typeof KeptItemSchema.Type;

/** An app's answer that does not keep the contract. */
class AppAnswerRefused extends Data.TaggedError("AppAnswerRefused")<{
  readonly app: DeletionApp;
  readonly reason: string;
}> {}

/**
 * The answer's actions, each id led by `<app>:` and named once, each default
 * one of its own choices; otherwise refused, so no app answers for another.
 */
function checkActions(
  app: DeletionApp,
  actions: ReadonlyArray<AppOpenAction>,
): Effect.Effect<ReadonlyArray<AppOpenAction>, AppAnswerRefused> {
  const seen = new Set<string>();
  for (const action of actions) {
    if (!action.id.startsWith(`${app}:`)) {
      return Effect.fail(new AppAnswerRefused({ app, reason: "action_of_another_app" }));
    }
    if (seen.has(action.id)) {
      return Effect.fail(new AppAnswerRefused({ app, reason: "action_twice" }));
    }
    seen.add(action.id);
    if (
      action.defaultChoice !== null &&
      !action.choices.some((choice) => choice.choice === action.defaultChoice)
    ) {
      return Effect.fail(new AppAnswerRefused({ app, reason: "default_not_a_choice" }));
    }
  }
  return Effect.succeed(actions);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** One app's part of a deletion preview. */
export type AppPreview =
  | {
      readonly app: DeletionApp;
      readonly status: "checked";
      readonly actions: ReadonlyArray<AppOpenAction>;
    }
  | { readonly app: DeletionApp; readonly status: "skipped" }
  | { readonly app: DeletionApp; readonly status: "could_not_check" };

/** What a preview asks each app about. */
export interface DeletionPreviewInput {
  readonly profileIds: ReadonlyArray<string>;
  /** Unix seconds the fan-out will reach the apps, if the deletion is asked for now. */
  readonly deletesAt: number;
}

const resultOf = (cause: unknown): "timeout" | "error" =>
  cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
    ? "timeout"
    : "error";

const previewOne = (
  config: DeletionAppsConfig,
  entry: DeletionAppEntry,
  input: DeletionPreviewInput,
): Effect.Effect<AppPreview, never, Db> => {
  const target = appTarget(config, entry.app);
  if (target.kind === "skip") {
    metricAccountDeletionAppPreview(entry.app, "skipped");
    return Effect.succeed({ app: entry.app, status: "skipped" });
  }
  if (target.kind === "unconfigured") {
    metricAccountDeletionAppPreview(entry.app, "error");
    return Effect.logError("account.deletion app has no URL on a deployed tier", {
      app: entry.app,
    }).pipe(Effect.as({ app: entry.app, status: "could_not_check" } as const));
  }
  return arcPostJsonEffect(
    `${target.url}/internal/account-deletion-preview`,
    { profileIds: input.profileIds, deletesAt: input.deletesAt },
    {
      audience: entry.audience,
      scope: "account:deletion-preview",
      timeoutMs: config.previewTimeoutMs,
    },
    config.arc,
  ).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(PreviewAnswer)(raw).pipe(
        Effect.mapError(() => new AppAnswerRefused({ app: entry.app, reason: "undecodable" })),
      ),
    ),
    Effect.flatMap((answer) => checkActions(entry.app, answer.openActions)),
    Effect.map((actions): AppPreview => {
      metricAccountDeletionAppPreview(entry.app, "ok");
      return { app: entry.app, status: "checked", actions };
    }),
    Effect.catch((cause) => {
      metricAccountDeletionAppPreview(entry.app, resultOf(cause));
      return Effect.logWarning("account.deletion app preview failed", {
        app: entry.app,
        ...safeErrorSummary(cause),
      }).pipe(Effect.as({ app: entry.app, status: "could_not_check" } as const));
    }),
    Effect.withSpan("account.deletion.app_preview", { attributes: { app: entry.app } }),
  );
};

/**
 * Every app's open actions for `input`, all asked at once. An app that does
 * not answer in time, answers an error, or answers outside the contract is
 * `could_not_check`; one this tier does not run is `skipped`. Never fails.
 */
export const previewDeletionApps = (
  config: DeletionAppsConfig,
  input: DeletionPreviewInput,
): Effect.Effect<ReadonlyArray<AppPreview>, never, Db> =>
  Effect.all(
    DELETION_APPS.map((entry) => previewOne(config, entry, input)),
    { concurrency: "unbounded" },
  );

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/** What the fan-out sends one app. */
export interface AccountDeletedBody {
  readonly accountId: string;
  readonly profileIds: ReadonlyArray<string>;
  /** The person's answers to this app's actions only, by action id. */
  readonly choices: Readonly<Record<string, { readonly choice: string }>>;
  readonly deleteEverything: boolean;
  /** Only for an app that receives it ({@link DeletionAppEntry.receivesEmail}). */
  readonly email?: string;
}

/** An app did not finish the erasure: unreachable, an error, or an answer outside the contract. */
export class AppErasureFailed extends Data.TaggedError("AppErasureFailed")<{
  readonly app: DeletionApp;
  readonly result: "timeout" | "error";
  readonly cause: unknown;
}> {}

/** Sends `body` to `entry`'s app at `url` and answers what it kept. */
export const sendAccountDeleted = (
  config: DeletionAppsConfig,
  entry: DeletionAppEntry,
  url: string,
  body: AccountDeletedBody,
): Effect.Effect<ReadonlyArray<KeptItem>, AppErasureFailed, Db> =>
  arcPostJsonEffect(
    `${url}/internal/account-deleted`,
    body,
    { audience: entry.audience, scope: "account:erase", timeoutMs: config.fanoutTimeoutMs },
    config.arc,
  ).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(DeletedAnswer)(raw).pipe(
        Effect.mapError(() => new AppAnswerRefused({ app: entry.app, reason: "undecodable" })),
      ),
    ),
    Effect.map((answer) => answer.kept),
    Effect.mapError(
      (cause) => new AppErasureFailed({ app: entry.app, result: resultOf(cause), cause }),
    ),
    Effect.withSpan("account.deletion.fanout_app", { attributes: { app: entry.app } }),
  );

/** The actions of `app` in a job's stored answers, by action id. */
export function choicesForApp(
  app: DeletionApp,
  stored: Readonly<Record<string, { readonly choice: string }>>,
): Record<string, { readonly choice: string }> {
  return Object.fromEntries(
    Object.entries(stored)
      .filter(([action]) => action.startsWith(`${app}:`))
      .map(([action, answer]) => [action, { choice: answer.choice }]),
  );
}

// ---------------------------------------------------------------------------
// Sessions at the soft delete
// ---------------------------------------------------------------------------

/**
 * Ends the person's sessions in each app that keeps its own
 * (`endsSessionsAtSoftDelete`), best effort: a failure is counted and logged,
 * and the app's erasure at the end of the window deletes them anyway.
 */
export const endAppSessions = (
  config: DeletionAppsConfig,
  profileIds: ReadonlyArray<string>,
): Effect.Effect<void, never, Db> =>
  Effect.all(
    DELETION_APPS.filter((entry) => entry.endsSessionsAtSoftDelete).map((entry) => {
      const target = appTarget(config, entry.app);
      if (target.kind !== "url") return Effect.void;
      return arcPostJsonEffect(
        `${target.url}/internal/account-sessions/revoke`,
        { profileIds },
        {
          audience: entry.audience,
          scope: "account:sessions-revoke",
          timeoutMs: config.fanoutTimeoutMs,
        },
        config.arc,
      ).pipe(
        Effect.tap(() => Effect.sync(() => metricAccountDeletionAppSessionsEnded(entry.app, "ok"))),
        Effect.catch((cause) => {
          metricAccountDeletionAppSessionsEnded(entry.app, resultOf(cause));
          return Effect.logWarning("account.deletion app sessions not ended", {
            app: entry.app,
            ...safeErrorSummary(cause),
          });
        }),
        Effect.asVoid,
      );
    }),
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.withSpan("account.deletion.end_app_sessions"));
