import { accounts, connections, serviceAccounts, serviceAccountKeys, users } from "@osn/db/schema";
import { Db, DbLive } from "@osn/db/service";
import { evictPublicKeyCacheEntry, importKeyFromJwk } from "@shared/crypto";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { handlePrefixRange, likeContains, normaliseHandleQuery } from "@shared/db-utils/search";
import { and, asc, gte, inArray, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { requireArc } from "../lib/arc-middleware";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { createGraphService } from "../services/graph";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIENCE = "osn-api";
const SCOPE_GRAPH_READ = "graph:read";
/**
 * Dedicated scope for the profile → account resolution endpoint (S-M1
 * pulse-onboarding). `profileId → accountId` dissolves the multi-account
 * privacy invariant ([[identity-model]] §"Privacy Rules") if it leaks, so it
 * must not ride along with the general-purpose `graph:read` grant — only
 * services that genuinely key state by account (pulse-api onboarding,
 * cire-api account linking) are granted it.
 */
const SCOPE_RESOLVE_ACCOUNT = "graph:resolve-account";
/** Max profile IDs per batch request — stays well under SQLite's variable limit (999). */
const MAX_BATCH_PROFILE_IDS = 200;
/**
 * Minimum prefix length for handle prefix search. Below this we return an empty
 * list (not an error) so a single typed character can't enumerate the handle
 * namespace — the same friction social apps put on @-mention autocomplete.
 */
const MIN_SEARCH_PREFIX = 2;
/** Default page size for handle prefix search when the caller omits `limit`. */
const DEFAULT_SEARCH_LIMIT = 8;
/** Hard ceiling on handle prefix search results — caps the enumeration surface. */
const MAX_SEARCH_LIMIT = 10;
/**
 * Max characters accepted as a connection-search query. Longer input is a bug
 * or an abuse probe, never a real name someone is typing into an autocomplete.
 */
const MAX_CONNECTION_QUERY_LEN = 64;
/**
 * Exhaustive list of scopes this server will grant to any service. S-M101.
 *
 * `account:erase` — granted to Pulse / Zap on registration so osn-api can
 * mint outbound ARC tokens addressed at them with this scope when fanning
 * out a full-account deletion.
 *
 * `step-up:verify` + `app-enrollment:write` — granted to Pulse / Zap for the
 * Flow B leave-app callbacks: Pulse validates a user's step-up token via
 * `/internal/step-up/verify` and reports the leave via
 * `/internal/app-enrollment/leave`.
 *
 * `graph:resolve-account` — gates `/graph/internal/profile-account` only
 * (see SCOPE_RESOLVE_ACCOUNT above). Granted to pulse-api + cire-api.
 */
const PERMITTED_SCOPES = new Set([
  "graph:read",
  "graph:resolve-account",
  "account:erase",
  "step-up:verify",
  "app-enrollment:write",
  "org:read",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extracts a safe, non-leaking message from a caught error. */
function safeError(e: unknown): string {
  if (e instanceof Error) {
    if ("_tag" in e && (e._tag === "GraphError" || e._tag === "NotFoundError")) {
      return (e as { message: string }).message;
    }
  }
  return "Request failed";
}

/**
 * Normalises a handle the same way the user-facing identifier resolution does —
 * `@Alice` → `alice` — and collapses "nothing usable left" to `null` so a caller
 * can 404 rather than query for the empty string. `users.handle` is stored
 * lowercase (the `^[a-z0-9_]{1,30}$` HandleSchema rejects uppercase at
 * registration) and `findProfileByHandle` does an exact match, so the fold is
 * what makes `@Alice` resolve at all.
 *
 * The normalisation itself is `@shared/db-utils/search`'s, shared with the
 * people/organisation search service and cire's directory browse. This wrapper
 * adds only the `null`. Worth noting what moving to the shared version fixed:
 * the copy that lived here tested `raw.startsWith("@")` BEFORE trimming, so
 * `" @alice"` kept its sigil and resolved to nothing.
 */
function normaliseHandle(raw: string): string | null {
  const stripped = normaliseHandleQuery(raw);
  return stripped.length > 0 ? stripped : null;
}

// ---------------------------------------------------------------------------
// Internal graph routes — ARC token protected
// ---------------------------------------------------------------------------

/**
 * Creates the `/graph/internal/*` route group for service-to-service calls.
 *
 * All routes require `Authorization: ARC <token>` with `graph:read` scope
 * and audience `"osn-api"`. These are read-only endpoints consumed by
 * other OSN services (e.g. Pulse API via the graphBridge).
 *
 * @param dbLayer - Effect Layer providing Db (defaults to DbLive)
 */
export function createInternalGraphRoutes(
  dbLayer: Layer.Layer<Db> = DbLive,
  /** Shared application runtime (see `createAuthRoutes`). */
  runtime?: AppRuntime,
  // INTERNAL_SERVICE_SECRET gates `/register-service` + `/service-keys/:keyId`.
  // Threaded in by the caller because on workerd secrets live ONLY on the `env`
  // binding, not `process.env`. Defaults to `process.env` for the Bun path;
  // unset ⇒ those endpoints answer 501 (service registration disabled).
  internalServiceSecret: string | undefined = process.env.INTERNAL_SERVICE_SECRET,
  /**
   * S-L30. Every sibling route factory merges the observability layer into its
   * fallback runtime; this one did not, so anything these handlers or the
   * graph service logged on the layer path went to Effect's default logger —
   * unredacted, unexported. Production passes the shared `runtime` and never
   * reaches the fallback, which is exactly why the gap could sit unnoticed
   * until a local or test run needed a log line.
   */
  loggerLayer: Layer.Layer<never> = Layer.empty,
) {
  const graph = createGraphService();

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));

  return (
    new Elysia({ prefix: "/graph/internal" })
      // -----------------------------------------------------------------------
      // Symmetric block check
      // User-facing endpoint only exposes one-directional isBlocked;
      // eitherBlocked is reserved for S2S callers (see graph.ts comment M1).
      // -----------------------------------------------------------------------
      .get(
        "/either-blocked",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            run,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            const blocked = await run(graph.eitherBlocked(query.profileA, query.profileB));
            return { blocked };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            profileA: t.String({ minLength: 1 }),
            profileB: t.String({ minLength: 1 }),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Connection status between two profiles
      // -----------------------------------------------------------------------
      .get(
        "/connection-status",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            run,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            const status = await run(graph.getConnectionStatus(query.viewerId, query.targetId));
            return { status };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            viewerId: t.String({ minLength: 1 }),
            targetId: t.String({ minLength: 1 }),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // List connection IDs for a profile (returns IDs only for bridge efficiency)
      // -----------------------------------------------------------------------
      .get(
        "/connections",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            run,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          const limit = query.limit ? parseInt(query.limit, 10) : undefined;

          try {
            const list = await run(
              graph.listConnections(query.profileId, {
                limit: Number.isFinite(limit) ? limit : undefined,
              }),
            );
            return { connectionIds: list.map((c) => c.profile.id) };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            profileId: t.String({ minLength: 1 }),
            limit: t.Optional(t.String()),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Service account self-registration / key rotation
      //
      // A S2S service (e.g. pulse-api) calls this on startup to register (or
      // rotate) its public key. Protected by INTERNAL_SERVICE_SECRET — a
      // shared secret between osn/api and the registering service. This
      // eliminates the need for pre-distributed private keys in .env files.
      //
      // Body:
      //   serviceId     — the service identifier (e.g. "pulse-api")
      //   keyId         — UUID that becomes the `kid` JWT header field
      //   publicKeyJwk  — ES256 public key in JWK JSON string form
      //   allowedScopes — comma-separated scopes (e.g. "graph:read")
      //   expiresAt     — optional unix seconds; omit for non-expiring stable keys
      //
      // Omit INTERNAL_SERVICE_SECRET in the environment to disable this
      // endpoint (it returns 501 when the env var is unset).
      // -----------------------------------------------------------------------
      .post(
        "/register-service",
        async ({ body, headers, set }) => {
          const secret = internalServiceSecret;
          if (!secret) {
            set.status = 501;
            return { error: "Service registration is disabled on this instance" };
          }
          if (!timingSafeEqualString(headers["authorization"] ?? "", `Bearer ${secret}`)) {
            set.status = 401;
            return { error: "Unauthorized" };
          }
          // Validate requested scopes against the server-side allowlist (S-M101).
          const requestedScopes = body.allowedScopes
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          const invalidScopes = requestedScopes.filter((s) => !PERMITTED_SCOPES.has(s));
          if (invalidScopes.length > 0) {
            set.status = 400;
            return { error: `Unknown scopes: ${invalidScopes.join(", ")}` };
          }
          // S-M1: Validate the JWK can be imported before writing it to the DB.
          // Prevents storage of malformed or non-EC keys that would later cause
          // resolvePublicKey to throw on every ARC verification attempt.
          try {
            await importKeyFromJwk(body.publicKeyJwk);
          } catch {
            set.status = 400;
            return { error: "Invalid public key JWK" };
          }
          try {
            const now = new Date();
            // S-L1: refuse to overwrite a kid that's already registered to
            // a different serviceId. The shared INTERNAL_SERVICE_SECRET is
            // a single trust anchor — without this guard, any holder could
            // pivot across services laterally by reusing another service's
            // kid. (kids are random UUIDs so collisions don't happen by
            // chance; rejecting protects against a deliberate one.)
            const existing = await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                const rows = yield* Effect.tryPromise({
                  try: () =>
                    db
                      .select({ serviceId: serviceAccountKeys.serviceId })
                      .from(serviceAccountKeys)
                      .where(eq(serviceAccountKeys.keyId, body.keyId))
                      .limit(1),
                  catch: (cause) => new Error("DB error checking service_account_keys", { cause }),
                });
                return rows[0] ?? null;
              }),
            );
            if (existing && existing.serviceId !== body.serviceId) {
              set.status = 409;
              return { error: "kid_serviceid_mismatch" };
            }
            await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                // Upsert service_accounts for allowed scopes
                yield* Effect.tryPromise({
                  try: () =>
                    db
                      .insert(serviceAccounts)
                      .values({
                        serviceId: body.serviceId,
                        allowedScopes: body.allowedScopes,
                        createdAt: now,
                        updatedAt: now,
                      })
                      .onConflictDoUpdate({
                        target: serviceAccounts.serviceId,
                        set: { allowedScopes: body.allowedScopes, updatedAt: now },
                      }),
                  catch: (cause) => new Error("DB error upserting service_accounts", { cause }),
                });
                // Upsert key row in service_account_keys
                yield* Effect.tryPromise({
                  try: () =>
                    db
                      .insert(serviceAccountKeys)
                      .values({
                        keyId: body.keyId,
                        serviceId: body.serviceId,
                        publicKeyJwk: body.publicKeyJwk,
                        registeredAt: now,
                        expiresAt: body.expiresAt ?? null,
                        revokedAt: null,
                      })
                      .onConflictDoUpdate({
                        target: serviceAccountKeys.keyId,
                        set: {
                          publicKeyJwk: body.publicKeyJwk,
                          expiresAt: body.expiresAt ?? null,
                          revokedAt: null,
                        },
                      }),
                  catch: (cause) => new Error("DB error upserting service_account_keys", { cause }),
                });
              }),
            );
            return { ok: true };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          body: t.Object({
            serviceId: t.String({ minLength: 1 }),
            keyId: t.String({ minLength: 1 }),
            publicKeyJwk: t.String({ minLength: 1 }),
            allowedScopes: t.String({ minLength: 1 }),
            expiresAt: t.Optional(t.Number()),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Revoke a service key by ID
      //
      // Sets revokedAt on the key row; the key will be rejected by
      // resolvePublicKey immediately (no wait for natural expiry).
      // Protected by the same INTERNAL_SERVICE_SECRET.
      // -----------------------------------------------------------------------
      .delete(
        "/service-keys/:keyId",
        async ({ params, headers, set }) => {
          const secret = internalServiceSecret;
          if (!secret) {
            set.status = 501;
            return { error: "Service registration is disabled on this instance" };
          }
          if (!timingSafeEqualString(headers["authorization"] ?? "", `Bearer ${secret}`)) {
            set.status = 401;
            return { error: "Unauthorized" };
          }
          try {
            const nowSecs = Math.floor(Date.now() / 1000);
            await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                yield* Effect.tryPromise({
                  try: () =>
                    db
                      .update(serviceAccountKeys)
                      .set({ revokedAt: nowSecs })
                      .where(eq(serviceAccountKeys.keyId, params.keyId)),
                  catch: (cause) => new Error("DB error revoking key", { cause }),
                });
              }),
            );
            // Evict immediately so the revocation takes effect in this process
            // without waiting for the 5-minute cache TTL (S-H100).
            evictPublicKeyCacheEntry(params.keyId);
            return { ok: true };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          params: t.Object({ keyId: t.String({ minLength: 1 }) }),
        },
      )
      // -----------------------------------------------------------------------
      // Profile → account lookup
      //
      // Resolves the accountId that owns `profileId`. Used by Pulse to key
      // its `pulse_account_onboarding` table by account so a user with
      // multiple OSN profiles only onboards once. The result is cached on
      // the Pulse side (see `pulse_profile_accounts`); this endpoint is
      // hit at most once per profile.
      //
      // Privacy note: accountId is intentionally absent from access-token
      // claims and user-facing responses (see osn/api/tests/privacy.test.ts).
      // It is only ever exchanged S2S over ARC, never to clients.
      //
      // S-M1 (pulse-onboarding): gated by the dedicated
      // `graph:resolve-account` scope, NOT the general `graph:read` — a
      // generic graph consumer must not be able to enumerate
      // profileId → accountId and dissolve the multi-account privacy
      // invariant. Grant the scope only to services that key state by
      // account (pulse-api, cire-api).
      // -----------------------------------------------------------------------
      .get(
        "/profile-account",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            run,
            AUDIENCE,
            SCOPE_RESOLVE_ACCOUNT,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            const rows = await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                return yield* Effect.tryPromise({
                  // S-H4 (tombstone rule): join accounts and require
                  // deletedAt IS NULL so a soft-deleted account cannot be
                  // resolved by downstream services during the grace
                  // window — otherwise the surviving cancel-handle session
                  // could keep writing app-side rows after a purge.
                  try: () =>
                    db
                      .select({ accountId: users.accountId })
                      .from(users)
                      .innerJoin(accounts, eq(users.accountId, accounts.id))
                      .where(and(eq(users.id, query.profileId), isNull(accounts.deletedAt)))
                      .limit(1),
                  catch: (cause) => new Error("DB query failed", { cause }),
                });
              }),
            );
            const row = rows[0];
            if (!row) {
              set.status = 404;
              return { error: "Profile not found" };
            }
            return { accountId: row.accountId };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            profileId: t.String({ minLength: 1 }),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Handle → profile lookup
      //
      // Resolves the profile id (`usr_*`) that owns `handle`. Used by cire to
      // turn an OSN handle an organiser types (e.g. `@alice`) into a profile id
      // it can store as a wedding co-host — cire has no other way to map a
      // handle to a profile.
      //
      // Same tombstone rule as /profile-account: the accounts join + deletedAt
      // IS NULL means a soft-deleted account is invisible during the grace
      // window, so a downstream service can't resolve (and then add as a host) a
      // profile whose account is mid-deletion.
      //
      // Disclosure note: handle existence is already inferable from osn's own
      // public surfaces (the user-facing handle lookup), so confirming a handle
      // resolves to a profile leaks nothing beyond what /profile-displays (which
      // returns handle + displayName for any known profile id) already exposes
      // to graph:read holders. `displayName` is returned so cire can show the
      // resolved person before the organiser confirms the add.
      // -----------------------------------------------------------------------
      .get(
        "/profile-by-handle",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            run,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          const handle = normaliseHandle(query.handle);
          if (!handle) {
            set.status = 404;
            return { error: "Profile not found" };
          }

          try {
            const rows = await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                return yield* Effect.tryPromise({
                  try: () =>
                    db
                      .select({
                        id: users.id,
                        handle: users.handle,
                        displayName: users.displayName,
                      })
                      .from(users)
                      .innerJoin(accounts, eq(users.accountId, accounts.id))
                      .where(and(eq(users.handle, handle), isNull(accounts.deletedAt)))
                      .limit(1),
                  catch: (cause) => new Error("DB query failed", { cause }),
                });
              }),
            );
            const row = rows[0];
            if (!row) {
              set.status = 404;
              return { error: "Profile not found" };
            }
            return { profileId: row.id, handle: row.handle, displayName: row.displayName };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            handle: t.String({ minLength: 1, maxLength: 64 }),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Handle prefix search (co-host autocomplete)
      //
      // Suggests profiles whose handle starts with `prefix`, so cire's organiser
      // portal can autocomplete a co-host as the organiser types. Same tombstone
      // rule as the sibling endpoints (accounts join + deletedAt IS NULL) so a
      // mid-deletion account never surfaces in a suggestion list.
      //
      // Enumeration guardrails: a minimum prefix length (returns an empty list
      // below it, never an error), an ordered + hard-capped result set
      // (≤ MAX_SEARCH_LIMIT), and the same graph:read ARC gate as every other
      // internal endpoint. Handles are already public identifiers (@usernames),
      // so this exposes nothing beyond what the exact /profile-by-handle lookup
      // does — it just lets the caller find a handle without typing it in full.
      //
      // The prefix match is an explicit BINARY range, NOT `handle LIKE 'q%'`:
      // the LIKE form does not use `users_handle_idx` and degrades to a full
      // index traversal on every keystroke. See `handlePrefixRange` in
      // `@shared/db-utils/search` for why, and note that the range also makes
      // `_` literal for free — no LIKE escaping needed on this path.
      // -----------------------------------------------------------------------
      .get(
        "/profile-search",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            run,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          const prefix = normaliseHandle(query.prefix);
          // Below the minimum length we return an empty list rather than an
          // error — a typo or a single keystroke shouldn't be a 4xx, and the
          // empty result is what keeps the enumeration surface small.
          if (!prefix || prefix.length < MIN_SEARCH_PREFIX) {
            return { profiles: [] };
          }

          // Clamp limit to [1, MAX_SEARCH_LIMIT]; default when absent/garbage.
          const parsedLimit = query.limit ? parseInt(query.limit, 10) : DEFAULT_SEARCH_LIMIT;
          const limit =
            Number.isFinite(parsedLimit) && parsedLimit > 0
              ? Math.min(parsedLimit, MAX_SEARCH_LIMIT)
              : DEFAULT_SEARCH_LIMIT;

          // `null` ⇒ the prefix contains a character no handle can hold, so it
          // cannot match anything. Skip the query rather than scan for zero rows.
          const range = handlePrefixRange(prefix);
          if (!range) return { profiles: [] };

          try {
            const rows = await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                return yield* Effect.tryPromise({
                  try: () =>
                    db
                      .select({
                        id: users.id,
                        handle: users.handle,
                        displayName: users.displayName,
                        avatarUrl: users.avatarUrl,
                      })
                      .from(users)
                      .innerJoin(accounts, eq(users.accountId, accounts.id))
                      .where(
                        and(
                          // Half-open BINARY range — an index SEEK, where the
                          // equivalent `LIKE 'q%'` is an index SCAN.
                          gte(users.handle, range.lower),
                          lt(users.handle, range.upper),
                          isNull(accounts.deletedAt),
                        ),
                      )
                      .orderBy(asc(users.handle))
                      .limit(limit),
                  catch: (cause) => new Error("DB query failed", { cause }),
                });
              }),
            );
            return { profiles: rows };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            prefix: t.String({ minLength: 1, maxLength: 64 }),
            limit: t.Optional(t.String()),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Connection search (co-host autocomplete, scoped to ONE profile's graph)
      //
      // Answers "which of `profileId`'s connections match what they're typing?"
      // — the graph-aware half of cire's add-co-host autocomplete. A wedding's
      // co-hosts are overwhelmingly people the organiser already knows on OSN
      // (a partner, a sibling, their planner), so their own connections are a
      // far better first suggestion than a global handle scan.
      //
      // Three differences from /profile-search above, all downstream of the fact
      // that this returns only the caller-named profile's OWN graph — a list
      // that profile can already read in full via the user-facing
      // `GET /graph/connections`:
      //
      //   1. No minimum query length. The enumeration floor on /profile-search
      //      exists because that endpoint walks the whole handle namespace; a
      //      single accepted-connection list has no namespace to enumerate. An
      //      EMPTY query is therefore valid and meaningful: it returns the first
      //      page of connections, which is what lets the portal pop the dropdown
      //      open on focus, before a keystroke.
      //   2. Matching includes `displayName`, and by substring rather than
      //      prefix — you remember a connection as "Priya", not as `@pk_1994`.
      //      Widening the match is safe here for the same reason: the candidate
      //      set is bounded by the graph, not by the namespace.
      //   3. `status = 'accepted'` only. A pending request is not a connection,
      //      and surfacing one would leak that a request is in flight.
      //
      // CALLER INVARIANT: `profileId` MUST be the calling service's own
      // authenticated end user — its access token's `sub` — and NEVER a value
      // taken from a client request. Nothing on this side can enforce that: the
      // ARC gate authenticates the *service*, not the end user it is acting for,
      // so a consumer that forwards a client-supplied profile id turns this into
      // arbitrary graph enumeration in one line. cire's route takes it from
      // `osnAuth()`'s derived `osnProfileId`; any new consumer must do the same.
      // (`/connections` already has this exact shape, so this endpoint does not
      // widen the trust boundary — it inherits it.)
      //
      // Discloses nothing new to a `graph:read` holder: /connections already
      // returns any profile's connection ids under this scope, and
      // /profile-displays already maps ids → handle + displayName. This is those
      // two calls fused, filtered, and capped. One caveat on that equivalence:
      // /connections clamps at 100 rows with no offset, so for a profile with
      // more than 100 connections a *filtered* query here can reach an edge that
      // paging there cannot. Same tombstone rule as its siblings (accounts join
      // + deletedAt IS NULL), so an account mid-deletion never surfaces as a
      // suggestion. Blocks need no separate filter: blocking deletes the
      // connection row (see graph.blockProfile), so a blocked pair cannot be
      // `accepted` here.
      // -----------------------------------------------------------------------
      .get(
        "/connection-search",
        async ({ query, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            run,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          const viewerId = query.profileId;

          // Clamp limit to [1, MAX_SEARCH_LIMIT]; default when absent/garbage.
          const parsedLimit = query.limit ? parseInt(query.limit, 10) : DEFAULT_SEARCH_LIMIT;
          const limit =
            Number.isFinite(parsedLimit) && parsedLimit > 0
              ? Math.min(parsedLimit, MAX_SEARCH_LIMIT)
              : DEFAULT_SEARCH_LIMIT;

          // The typed fragment, `@`-stripped and folded. Empty is legal (see the
          // header comment) and simply means "no filter — first page".
          const fragment = normaliseHandleQuery(query.q ?? "");
          if (fragment.length > MAX_CONNECTION_QUERY_LEN) {
            return { profiles: [] };
          }
          // The handle half is a range (index-friendly, and `_` is literal for
          // free); the display-name half stays a LIKE because it is a SUBSTRING
          // match, which no range can express. `null` here means the fragment
          // can't prefix a handle — the display-name arm still can, so this
          // narrows the OR rather than short-circuiting the query.
          const range = handlePrefixRange(fragment);
          const namePattern = likeContains(fragment);

          try {
            const rows = await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                return yield* Effect.tryPromise({
                  try: () =>
                    db
                      .select({
                        id: users.id,
                        handle: users.handle,
                        displayName: users.displayName,
                        avatarUrl: users.avatarUrl,
                      })
                      .from(connections)
                      // Join the PEER of the pair: whichever side isn't the
                      // viewer. Expressing the direction in the join condition
                      // (rather than a CASE in the projection) keeps both
                      // `connections_requester_idx` and `_addressee_idx` usable.
                      .innerJoin(
                        users,
                        or(
                          and(
                            eq(connections.requesterId, viewerId),
                            eq(users.id, connections.addresseeId),
                          ),
                          and(
                            eq(connections.addresseeId, viewerId),
                            eq(users.id, connections.requesterId),
                          ),
                        ),
                      )
                      .innerJoin(accounts, eq(users.accountId, accounts.id))
                      .where(
                        and(
                          eq(connections.status, "accepted"),
                          isNull(accounts.deletedAt),
                          // No fragment ⇒ no filter (first page of connections).
                          fragment.length > 0
                            ? or(
                                range
                                  ? and(
                                      gte(users.handle, range.lower),
                                      lt(users.handle, range.upper),
                                    )
                                  : undefined,
                                // Substring, not prefix — "priya" should find
                                // "Anaya Priyadarshini". LIKE is case-insensitive
                                // for ASCII in SQLite, and displayName may be
                                // NULL (LIKE on NULL is NULL ⇒ simply no match).
                                sql`${users.displayName} LIKE ${namePattern} ESCAPE '\\'`,
                              )
                            : undefined,
                        ),
                      )
                      .orderBy(asc(users.handle))
                      .limit(limit),
                  catch: (cause) => new Error("DB query failed", { cause }),
                });
              }),
            );
            return { profiles: rows };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: t.Object({
            profileId: t.String({ minLength: 1 }),
            /**
             * The typed fragment. Optional + empty-legal (see header comment).
             *
             * The schema bound is deliberately looser than the handler's
             * `MAX_CONNECTION_QUERY_LEN` (64): anything between the two degrades
             * to an empty list rather than a 422, because every failure on an
             * autocomplete path should read as "no suggestions" rather than as
             * an error the caller has to special-case. The outer bound is still
             * declared so an unbounded string is never allocated or normalised
             * — the handler's guard rejects *after* three O(n) passes.
             */
            q: t.Optional(t.String({ maxLength: 256 })),
            limit: t.Optional(t.String()),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // Batch profile display metadata
      // -----------------------------------------------------------------------
      .post(
        "/profile-displays",
        async ({ body, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            run,
            AUDIENCE,
            SCOPE_GRAPH_READ,
          );
          if (!caller) return { error: "Unauthorized" };

          try {
            if (body.profileIds.length === 0) return { profiles: [] };

            const rows = await run(
              Effect.gen(function* () {
                const { db } = yield* Db;
                return yield* Effect.tryPromise({
                  try: () =>
                    db
                      .select({
                        id: users.id,
                        handle: users.handle,
                        displayName: users.displayName,
                        avatarUrl: users.avatarUrl,
                      })
                      .from(users)
                      .where(inArray(users.id, body.profileIds)),
                  catch: (cause) => new Error("DB query failed", { cause }),
                });
              }),
            );

            return { profiles: rows };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          body: t.Object({
            profileIds: t.Array(t.String({ minLength: 1 }), { maxItems: MAX_BATCH_PROFILE_IDS }),
          }),
        },
      )
  );
}
