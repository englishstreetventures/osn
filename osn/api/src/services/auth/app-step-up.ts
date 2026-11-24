/**
 * An app's step-up request: how an app whose own pages cannot run a step-up
 * (cire's organiser portal holds no OSN token, and passkeys are bound to
 * Musubi's origin) gets the person's confirmation for one destructive action.
 *
 * 1. **Begin** (`POST /internal/step-up/requests`, ARC from the app). The app
 *    names the profile it signed its caller in as, the hex SHA-256 of a secret
 *    only its cookie in that browser holds (`binding`), and where Musubi sends
 *    the person back (`returnTo`, pinned to the app's configured portal
 *    origin). The request is kept for ten minutes, pending.
 * 2. **Confirm** (`POST /step-up/requests/:id/confirm`, Bearer on Musubi). The
 *    person, signed in to Musubi as the same account, steps up for the
 *    request's purpose with a passkey, one an emailed link, an authenticator
 *    code or recovery added only once it is 72 hours old; the token is spent
 *    here. The request becomes
 *    confirmed for five minutes, with the hash of a fresh code and the family
 *    of the confirming session, and Musubi sends the browser to `returnTo`
 *    with the code on its fragment.
 * 3. **Verify** (`POST /internal/step-up/verify` with a `request`, ARC from the
 *    app). The app presents the request id, its secret's hash and the code.
 *    Nothing is spent: the request serves the one removal for its five
 *    minutes.
 *
 * Someone who has stolen the app's session cookie can begin a request in
 * their own browser, but the code goes to the browser of the person who
 * confirms, and the secret stays in the browser that began: neither holds
 * both.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { accounts, sessions, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import { metricAppStepUpRequest } from "../../metrics";
import type { AuthContext } from "./context";
import { type AuthError, type CoordinationError, DatabaseError, isAuthError } from "./errors";
import { APP_DELETE_HOLD, type StepUpModule } from "./step-up";
import { storeCall } from "./store-call";
import type { AppStepUpRequest } from "./stores";

/** The purposes an app spends through a request; each spent by one app only. */
export type AppStepUpPurpose = AppStepUpRequest["purpose"];

/** The one ARC issuer that may begin and verify each purpose's requests. */
export const APP_STEP_UP_ISSUER = {
  cire_app_delete: "cire-api",
} as const satisfies Record<AppStepUpPurpose, string>;

/** How long a begun request waits for the person to confirm it. */
const PENDING_TTL_MS = 10 * 60_000;

/** How long a confirmed request serves the app. */
export const CONFIRMED_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Where the person may be sent back to
// ---------------------------------------------------------------------------

/** Each purpose's return origin on this tier, and whether this is a local run. */
export interface AppStepUpReturnConfig {
  readonly local: boolean;
  readonly origins: Readonly<Partial<Record<AppStepUpPurpose, string>>>;
}

/** The variables {@link appStepUpReturnConfig} reads. */
export interface AppStepUpReturnEnv {
  readonly OSN_ENV?: string;
  /** cire's organiser portal (`https://host.cireweddings.com`); `musubi/infra` sets it. */
  readonly CIRE_ORGANISER_ORIGIN?: string;
}

/** Plain HTTP reaches only this machine, where the local and E2E stacks run. */
const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";

/**
 * The return origins from the deployment's variables. Throws on a configured
 * origin that is not `https:` (or, on a local run, `http:` to a loopback
 * host): the boot answers 503, as a bad app URL does. Unset is no error: the
 * purpose's requests are refused as unavailable on a deployed tier, and admit
 * any loopback origin on a local run.
 */
export function appStepUpReturnConfig(env: AppStepUpReturnEnv): AppStepUpReturnConfig {
  const local = !env.OSN_ENV || env.OSN_ENV === "local";
  const raw = env.CIRE_ORGANISER_ORIGIN?.trim();
  if (!raw) return { local, origins: {} };
  const usable =
    URL.canParse(raw) &&
    (() => {
      const { protocol, hostname } = new URL(raw);
      return protocol === "https:" || (local && protocol === "http:" && isLoopbackHost(hostname));
    })();
  if (!usable) {
    throw new Error(
      `CIRE_ORGANISER_ORIGIN must be an https: origin${local ? ", or http: to a loopback host" : ""}`,
    );
  }
  return { local, origins: { cire_app_delete: new URL(raw).origin } };
}

/** Whether a request for `purpose` may send the person back to `returnTo`. */
export function returnToAdmitted(
  config: AppStepUpReturnConfig,
  purpose: AppStepUpPurpose,
  returnTo: string,
): "ok" | "refused" | "unavailable" {
  const configured = config.origins[purpose];
  if (!configured && !config.local) return "unavailable";
  if (!URL.canParse(returnTo)) return "refused";
  const url = new URL(returnTo);
  if (configured) return url.origin === configured ? "ok" : "refused";
  return (url.protocol === "https:" || url.protocol === "http:") && isLoopbackHost(url.hostname)
    ? "ok"
    : "refused";
}

/** `returnTo` with `code` added to its fragment's query. */
function withCode(returnTo: string, code: string): string {
  const url = new URL(returnTo);
  const hash = url.hash.replace(/^#/, "");
  url.hash = `${hash}${hash.includes("?") ? "&" : "?"}code=${code}`;
  return url.toString();
}

// ---------------------------------------------------------------------------
// The requests
// ---------------------------------------------------------------------------

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const randomToken = (bytes: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

/** Constant-time equality of two hex digests. */
const sameDigest = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** What a begin answers. */
export type AppStepUpBegun =
  | { readonly ok: true; readonly requestId: string }
  | { readonly ok: false; readonly reason: "not_found" | "return_to_refused" | "unavailable" };

/** What a verify answers. */
export type AppStepUpVerified =
  | { readonly ok: true; readonly accountId: string; readonly profileIds: string[] }
  | { readonly ok: false };

export function createAppStepUpModule(ctx: AuthContext, stepUp: StepUpModule) {
  const store = ctx.stores.appStepUpRequests;
  const returns = ctx.config.appStepUpReturn ?? { local: true, origins: {} };

  /** The account owning `profileId`, unless it is unknown or its deletion is pending. */
  const liveOwner = (profileId: string): Effect.Effect<string | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ accountId: users.accountId })
            .from(users)
            .innerJoin(accounts, eq(accounts.id, users.accountId))
            .where(and(eq(users.id, profileId), isNull(accounts.deletedAt)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows[0]?.accountId ?? null;
    });

  /** Begin: one pending request for the account owning `profileId`. */
  const beginAppStepUp = (input: {
    readonly profileId: string;
    readonly purpose: AppStepUpPurpose;
    readonly binding: string;
    readonly returnTo: string;
  }): Effect.Effect<AppStepUpBegun, DatabaseError | CoordinationError, Db> =>
    Effect.gen(function* () {
      const admitted = returnToAdmitted(returns, input.purpose, input.returnTo);
      if (admitted === "unavailable") return { ok: false, reason: "unavailable" } as const;
      if (admitted === "refused") return { ok: false, reason: "return_to_refused" } as const;
      const accountId = yield* liveOwner(input.profileId);
      if (!accountId) return { ok: false, reason: "not_found" } as const;
      const requestId = randomToken(16);
      const entry: AppStepUpRequest = {
        state: "pending",
        accountId,
        purpose: input.purpose,
        binding: input.binding,
        returnTo: input.returnTo,
      };
      yield* storeCall(store, "set", () => store.set(requestId, entry, PENDING_TTL_MS));
      return { ok: true, requestId } as const;
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => metricAppStepUpRequest("begin", result.ok ? "ok" : "refused")),
      ),
      Effect.tapError(() => Effect.sync(() => metricAppStepUpRequest("begin", "error"))),
      Effect.withSpan("auth.app_step_up.begin"),
    );

  /** The pending request `requestId` of `accountId`, or null. */
  const pendingOf = (requestId: string, accountId: string) =>
    Effect.gen(function* () {
      const entry = yield* storeCall(store, "get", () => store.get(requestId));
      if (!entry || entry.state !== "pending" || entry.accountId !== accountId) return null;
      return entry;
    });

  /** Read, for Musubi's confirm page: the purpose and the host it returns to. */
  const readAppStepUp = (
    requestId: string,
    accountId: string,
  ): Effect.Effect<
    { readonly purpose: AppStepUpPurpose; readonly returnHost: string } | null,
    CoordinationError
  > =>
    Effect.gen(function* () {
      const entry = yield* pendingOf(requestId, accountId);
      if (!entry) return null;
      return { purpose: entry.purpose, returnHost: new URL(entry.returnTo).host };
    });

  /**
   * Confirm: spends `stepUpToken` for the request's purpose, then marks the
   * request confirmed with a new code's hash and the confirming session's
   * family, and answers where to send the person, the code on its fragment.
   * Null when there is no such pending request of the caller's account, or
   * another confirm took it first. A passkey still inside its hold fails with
   * `PasskeyHeldError`, which names when the hold ends; the request stays
   * pending and the token unspent.
   */
  const confirmAppStepUp = (
    requestId: string,
    confirming: { readonly accountId: string; readonly familyId: string },
    stepUpToken: string,
  ): Effect.Effect<
    { readonly returnTo: string } | null,
    AuthError | DatabaseError | CoordinationError,
    Db
  > =>
    Effect.gen(function* () {
      const entry = yield* pendingOf(requestId, confirming.accountId);
      if (!entry) return null;
      // Every purpose an app asks for removes that app's data: a passkey, past
      // its hold if an emailed link, an authenticator code or recovery added it.
      yield* stepUp.verifyStepUpToken(
        stepUpToken,
        confirming.accountId,
        ctx.appDeleteAllowedAmr,
        entry.purpose,
        APP_DELETE_HOLD,
      );
      const code = randomToken(32);
      const next: AppStepUpRequest = {
        state: "confirmed",
        accountId: entry.accountId,
        purpose: entry.purpose,
        binding: entry.binding,
        returnTo: entry.returnTo,
        codeHash: sha256Hex(code),
        familyId: confirming.familyId,
      };
      const won = yield* storeCall(store, "swap", () =>
        store.swap(requestId, entry, next, CONFIRMED_TTL_MS),
      );
      if (!won) return null;
      return { returnTo: withCode(entry.returnTo, code) };
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          metricAppStepUpRequest("confirm", isAuthError(err) ? "refused" : "error"),
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => metricAppStepUpRequest("confirm", result ? "ok" : "refused")),
      ),
      Effect.withSpan("auth.app_step_up.confirm"),
    );

  /**
   * Verify: the confirmed request `requestId` of the account owning
   * `profileId`, presented with its binding and code, while that account is
   * not pending deletion and the confirming session's family is live. Answers
   * the account and every profile of it. Spends nothing.
   */
  const verifyAppStepUp = (input: {
    readonly requestId: string;
    readonly purpose: AppStepUpPurpose;
    readonly profileId: string;
    readonly binding: string;
    readonly code: string;
  }): Effect.Effect<AppStepUpVerified, DatabaseError | CoordinationError, Db> =>
    Effect.gen(function* () {
      const entry = yield* storeCall(store, "get", () => store.get(input.requestId));
      if (
        !entry ||
        entry.state !== "confirmed" ||
        entry.purpose !== input.purpose ||
        !sameDigest(entry.binding, input.binding) ||
        !sameDigest(entry.codeHash, sha256Hex(input.code))
      ) {
        return { ok: false } as const;
      }
      // One read: every profile of the request's account, while that account
      // is not pending deletion and the confirming family has a live,
      // unrestricted, unexpired session. Empty when either fails; the
      // profile asked about must be among them.
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const profiles = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: users.id })
            .from(users)
            .innerJoin(accounts, eq(accounts.id, users.accountId))
            .where(
              and(
                eq(users.accountId, entry.accountId),
                isNull(accounts.deletedAt),
                sql`EXISTS (SELECT 1 FROM ${sessions} WHERE ${sessions.accountId} = ${entry.accountId} AND ${sessions.familyId} = ${entry.familyId} AND ${sessions.restrictedUntil} IS NULL AND ${sessions.expiresAt} > ${nowSec})`,
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (!profiles.some((row) => row.id === input.profileId)) return { ok: false } as const;
      return {
        ok: true,
        accountId: entry.accountId,
        profileIds: profiles.map((row) => row.id),
      } as const;
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => metricAppStepUpRequest("verify", result.ok ? "ok" : "refused")),
      ),
      Effect.tapError(() => Effect.sync(() => metricAppStepUpRequest("verify", "error"))),
      Effect.withSpan("auth.app_step_up.verify"),
    );

  return { beginAppStepUp, readAppStepUp, confirmAppStepUp, verifyAppStepUp };
}

export type AppStepUpModule = ReturnType<typeof createAppStepUpModule>;
