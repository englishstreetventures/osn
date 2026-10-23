import { users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { instrumentedFetch } from "@shared/observability";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  metricCireSessionRevocation,
  type CireSessionRevokeResult,
  type CireSessionRevokeTrigger,
} from "../metrics";

/**
 * Ending an account's cire organiser sessions from osn-api.
 *
 * cire-api signs an organiser in through OSN's OIDC provider and then holds
 * its own 7-day session, keyed on the raw OSN profile id. Nothing on the OSN
 * side reaches that session, so when the account signs out everywhere else, or
 * revokes the cire connection, osn-api asks cire-api to end it through
 * `POST /internal/revoke-organiser-sessions` (`cire/api/src/routes/internal-revoke.ts`):
 * one request per live profile of the account, each naming one profile id,
 * authenticated by a shared bearer secret.
 *
 * Best effort and never in the user's way: callers fork this with
 * `forkBackground`, every failure is an error log and a counter, and nothing
 * retries. Signing out everywhere else again sends every request again.
 */

export interface CireOrganiserRevokeConfig {
  /** cire-api's origin, no trailing slash (`CIRE_INTERNAL_REVOKE_URL`). */
  readonly url: string | null;
  /** The bearer secret cire-api's `CIRE_INTERNAL_REVOKE_SECRET` holds. */
  readonly secret: string | null;
  /** cire's OIDC client id (`CIRE_OIDC_CLIENT_ID`): revoking this connection ends cire sessions. */
  readonly clientId: string | null;
}

/** Nothing configured: no connection counts as cire's, and every revoke is skipped. */
export const DISABLED_CIRE_ORGANISER_REVOKE: CireOrganiserRevokeConfig = {
  url: null,
  secret: null,
  clientId: null,
};

const REVOKE_PATH = "/internal/revoke-organiser-sessions";
/** Per request. Five profiles at five at a time stay well inside `waitUntil`'s 30 seconds. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Accounts start with a cap of five profiles (`services/auth/registration.ts`). */
const CONCURRENCY = 5;

/** Reads the three settings; an unset or empty one is `null`. The secret is never trimmed. */
export function cireOrganiserRevokeConfig(env: {
  readonly CIRE_INTERNAL_REVOKE_URL?: string;
  readonly CIRE_INTERNAL_REVOKE_SECRET?: string;
  readonly CIRE_OIDC_CLIENT_ID?: string;
}): CireOrganiserRevokeConfig {
  const url = env.CIRE_INTERNAL_REVOKE_URL?.trim().replace(/\/+$/, "");
  return {
    url: url ? url : null,
    secret: env.CIRE_INTERNAL_REVOKE_SECRET ? env.CIRE_INTERNAL_REVOKE_SECRET : null,
    clientId: env.CIRE_OIDC_CLIENT_ID ? env.CIRE_OIDC_CLIENT_ID : null,
  };
}

/** Whether `clientId` is cire's. False whenever cire's client id is not configured. */
export function isCireClient(config: CireOrganiserRevokeConfig, clientId: string): boolean {
  return config.clientId !== null && config.clientId === clientId;
}

const record = (trigger: CireSessionRevokeTrigger, result: CireSessionRevokeResult) =>
  Effect.sync(() => metricCireSessionRevocation(trigger, result));

/** A thrown fetch's class, for the log: `TimeoutError`, `TypeError`, … Never its message. */
const errorName = (cause: unknown): string =>
  cause instanceof Error || (typeof cause === "object" && cause !== null && "name" in cause)
    ? String((cause as { name: unknown }).name)
    : typeof cause;

/** One request to cire for one profile. Never fails: every outcome is logged and counted. */
const revokeOne = (
  url: string,
  secret: string,
  osnProfileId: string,
  trigger: CireSessionRevokeTrigger,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const res = await instrumentedFetch(`${url}${REVOKE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ osnProfileId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // The body carries nothing this caller uses; release it rather than hold the connection.
      await res.body?.cancel();
      return res.status;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.matchEffect({
      onSuccess: (status) =>
        status >= 200 && status < 300
          ? record(trigger, "ok")
          : Effect.logError("cire organiser-session revoke rejected").pipe(
              Effect.annotateLogs({ trigger, status }),
              Effect.andThen(record(trigger, "rejected")),
            ),
      onFailure: (cause) => {
        const reason = errorName(cause);
        const timedOut = reason === "TimeoutError" || reason === "AbortError";
        return Effect.logError("cire organiser-session revoke failed").pipe(
          Effect.annotateLogs({ trigger, reason }),
          Effect.andThen(record(trigger, timedOut ? "timeout" : "error")),
        );
      },
    }),
  );

/**
 * Asks cire-api to end the organiser sessions of every live profile of
 * `accountId`. Never fails. Logs neither the secret, the account id nor any
 * profile id.
 */
export const revokeCireOrganiserSessions = (
  config: CireOrganiserRevokeConfig,
  accountId: string,
  trigger: CireSessionRevokeTrigger,
): Effect.Effect<void, never, Db> => {
  const { url, secret } = config;
  if (url === null || secret === null) {
    const missing = [
      url === null ? "CIRE_INTERNAL_REVOKE_URL" : null,
      secret === null ? "CIRE_INTERNAL_REVOKE_SECRET" : null,
    ]
      .filter((name) => name !== null)
      .join(", ");
    return Effect.logWarning("cire organiser sessions not revoked: back-channel unconfigured").pipe(
      Effect.annotateLogs({ trigger, missing }),
      Effect.andThen(record(trigger, "unconfigured")),
      Effect.withSpan("auth.cire_session.revoke", { attributes: { trigger } }),
    );
  }

  return Effect.gen(function* () {
    const { db } = yield* Db;
    const profiles = yield* Effect.tryPromise({
      try: () => db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId)),
      catch: (cause) => cause,
    });
    yield* Effect.forEach(profiles, (profile) => revokeOne(url, secret, profile.id, trigger), {
      concurrency: CONCURRENCY,
      discard: true,
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("cire organiser sessions not revoked: profile lookup failed").pipe(
        Effect.annotateLogs({ trigger, reason: errorName(cause) }),
        Effect.andThen(record(trigger, "error")),
      ),
    ),
    Effect.withSpan("auth.cire_session.revoke", { attributes: { trigger } }),
  );
};
