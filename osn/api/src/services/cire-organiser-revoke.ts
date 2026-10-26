import { oauthConsents, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { instrumentedFetch } from "@shared/observability";
import { and, eq, exists } from "drizzle-orm";
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
 * authenticated by a shared bearer secret. An account that has never signed in
 * to cire holds no cire session, so nothing about it is sent.
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

/** Nothing configured: every revoke that could be cire's is skipped with a warning. */
export const DISABLED_CIRE_ORGANISER_REVOKE: CireOrganiserRevokeConfig = {
  url: null,
  secret: null,
  clientId: null,
};

/**
 * The shortest secret either side accepts. cire-api refuses a shorter one
 * too (503), so a short value is reported here as unset rather than sent.
 */
export const MIN_REVOKE_SECRET_LENGTH = 32;

const REVOKE_PATH = "/internal/revoke-organiser-sessions";
/** Per request. Five profiles at five at a time stay well inside `waitUntil`'s 30 seconds. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Accounts start with a cap of five profiles (`services/auth/registration.ts`). */
const CONCURRENCY = 5;

/** Plain HTTP is accepted only to this machine, where the local and E2E stacks run. */
const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";

/** `raw` when it is an `https:` origin, or `http:` to a loopback host; otherwise `null`. */
const usableUrl = (raw: string): string | null => {
  if (!URL.canParse(raw)) return null;
  const { protocol, hostname } = new URL(raw);
  if (protocol === "https:") return raw;
  return protocol === "http:" && isLoopbackHost(hostname) ? raw : null;
};

/**
 * Reads the three settings. Each is `null` when unset or empty; the URL is
 * also `null` unless it is HTTPS (or HTTP to a loopback host), and the secret
 * unless it holds at least {@link MIN_REVOKE_SECRET_LENGTH} characters. The
 * secret is never trimmed.
 */
export function cireOrganiserRevokeConfig(env: {
  readonly CIRE_INTERNAL_REVOKE_URL?: string;
  readonly CIRE_INTERNAL_REVOKE_SECRET?: string;
  readonly CIRE_OIDC_CLIENT_ID?: string;
}): CireOrganiserRevokeConfig {
  const url = env.CIRE_INTERNAL_REVOKE_URL?.trim().replace(/\/+$/, "");
  const secret = env.CIRE_INTERNAL_REVOKE_SECRET;
  return {
    url: url ? usableUrl(url) : null,
    secret: secret && secret.length >= MIN_REVOKE_SECRET_LENGTH ? secret : null,
    clientId: env.CIRE_OIDC_CLIENT_ID ? env.CIRE_OIDC_CLIENT_ID : null,
  };
}

/**
 * Whether revoking the connection to `clientId` goes on to cire: it is cire's
 * client, or cire's client id is not configured, so no revoke can be told
 * apart from cire's. In the second case the revoke logs the back-channel as
 * unconfigured and sends nothing.
 */
export function revokeReachesCire(config: CireOrganiserRevokeConfig, clientId: string): boolean {
  return config.clientId === null || config.clientId === clientId;
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
        // The bearer goes to the configured origin and nowhere else: a
        // redirect comes back as its 3xx status, counted `rejected`.
        redirect: "manual",
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
 * `accountId`, when the account has ever signed in to cire. Never fails. Logs
 * neither the secret, the account id nor any profile id.
 */
export const revokeCireOrganiserSessions = (
  config: CireOrganiserRevokeConfig,
  accountId: string,
  trigger: CireSessionRevokeTrigger,
): Effect.Effect<void, never, Db> => {
  const { url, secret, clientId } = config;
  if (url === null || secret === null || clientId === null) {
    const missing = [
      url === null ? "CIRE_INTERNAL_REVOKE_URL" : null,
      secret === null ? "CIRE_INTERNAL_REVOKE_SECRET" : null,
      clientId === null ? "CIRE_OIDC_CLIENT_ID" : null,
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
    // cire's sign-in always records a consent row for its client before the
    // code that opens a cire session, and only account erasure deletes one, so
    // an account with none holds no cire session. A revoked row still counts.
    const signedInToCire = exists(
      db
        .select({ id: oauthConsents.id })
        .from(oauthConsents)
        .where(and(eq(oauthConsents.accountId, accountId), eq(oauthConsents.clientId, clientId))),
    );
    const profiles = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.accountId, accountId), signedInToCire)),
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
