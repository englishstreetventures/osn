import { serviceAccounts, serviceAccountKeys, users } from "@osn/db/schema";
import { Db, DbLive } from "@osn/db/service";
import { evictPublicKeyCacheEntry, importKeyFromJwk } from "@shared/crypto";
import { inArray, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { requireArc } from "../lib/arc-middleware";
import { createGraphService } from "../services/graph";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIENCE = "osn-api";
const SCOPE_GRAPH_READ = "graph:read";
/** Max profile IDs per batch request — stays well under SQLite's variable limit (999). */
const MAX_BATCH_PROFILE_IDS = 200;
/** Exhaustive list of scopes this server will grant to any service. S-M101. */
const PERMITTED_SCOPES = new Set(["graph:read"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time string equality check for shared-secret comparison (S-H101).
 * Length inequality is checked first; a mismatch returns false immediately
 * since length is not secret in a `Bearer <secret>` scheme.
 */
function isTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Extracts a safe, non-leaking message from a caught error. */
function safeError(e: unknown): string {
  if (e instanceof Error) {
    if ("_tag" in e && (e._tag === "GraphError" || e._tag === "NotFoundError")) {
      return (e as { message: string }).message;
    }
  }
  return "Request failed";
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
export function createInternalGraphRoutes(dbLayer: Layer.Layer<Db> = DbLive) {
  const graph = createGraphService();

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(dbLayer)) as Effect.Effect<A, never, never>);

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
          const secret = process.env.INTERNAL_SERVICE_SECRET;
          if (!secret) {
            set.status = 501;
            return { error: "Service registration is disabled on this instance" };
          }
          if (!isTimingSafeEqual(headers["authorization"] ?? "", `Bearer ${secret}`)) {
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
          const secret = process.env.INTERNAL_SERVICE_SECRET;
          if (!secret) {
            set.status = 501;
            return { error: "Service registration is disabled on this instance" };
          }
          if (!isTimingSafeEqual(headers["authorization"] ?? "", `Bearer ${secret}`)) {
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
