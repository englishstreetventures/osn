import { DbLive, type Db } from "@pulse/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import {
  PERMITTED_INBOUND_SCOPES,
  ServiceKeyMismatchError,
  registerServiceKey,
  requireArc,
  revokeServiceKey,
} from "../lib/arc-middleware";
import * as accountErasure from "../services/accountErasure";

const AUDIENCE = "pulse-api";
const SCOPE_ACCOUNT_ERASE = "account:erase";

function isTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Use a constant-time loop in lieu of Buffer.timingSafeEqual to keep
  // this lib browser-portable. JS strings are immutable so we can hash
  // both inputs with a simple XOR-accumulate.
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Internal pulse-api endpoints — ARC-gated (account-deleted) and
 * shared-secret-gated (register-service / service-keys/:keyId revoke).
 */
export const createInternalRoutes = (dbLayer: Layer.Layer<Db> = DbLive) =>
  new Elysia({ prefix: "/internal" })
    // ------------------------------------------------------------------
    // ARC public-key registration. Mirrors osn-api's
    // /graph/internal/register-service. osn-api calls this on startup with
    // the shared INTERNAL_SERVICE_SECRET to register the outbound key it
    // will use when fanning out a deletion to Pulse.
    // ------------------------------------------------------------------
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

        const requestedScopes = body.allowedScopes
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        const invalid = requestedScopes.filter((s) => !PERMITTED_INBOUND_SCOPES.has(s));
        if (invalid.length > 0) {
          set.status = 400;
          return { error: `Unknown scopes: ${invalid.join(", ")}` };
        }

        try {
          await registerServiceKey({
            serviceId: body.serviceId,
            keyId: body.keyId,
            publicKeyJwk: body.publicKeyJwk,
            allowedScopes: body.allowedScopes,
            expiresAt: body.expiresAt,
          });
          return { ok: true };
        } catch (e) {
          if (e instanceof ServiceKeyMismatchError) {
            set.status = 409;
            return { error: "kid_serviceid_mismatch" };
          }
          set.status = 400;
          return { error: "Invalid public key JWK" };
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
    .delete(
      "/service-keys/:keyId",
      ({ params, headers, set }) => {
        const secret = process.env.INTERNAL_SERVICE_SECRET;
        if (!secret) {
          set.status = 501;
          return { error: "Service registration is disabled on this instance" };
        }
        if (!isTimingSafeEqual(headers["authorization"] ?? "", `Bearer ${secret}`)) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        revokeServiceKey(params.keyId);
        return { ok: true };
      },
      { params: t.Object({ keyId: t.String({ minLength: 1 }) }) },
    )
    // ------------------------------------------------------------------
    // ARC-gated `/internal/account-deleted` — called by osn-api when
    // fanning out a full-account deletion. Hard-deletes Pulse data for
    // the supplied profile IDs (no grace; osn-api already enforced its
    // own 7-day window before fanning out).
    // ------------------------------------------------------------------
    .post(
      "/account-deleted",
      async ({ body, headers, set }) => {
        const caller = await requireArc(headers.authorization, set, AUDIENCE, SCOPE_ACCOUNT_ERASE);
        if (!caller) return { error: "Unauthorized" };
        try {
          const result = await Effect.runPromise(
            accountErasure
              .purgeAccount(body.accountId, body.profileIds)
              .pipe(Effect.provide(dbLayer)) as Effect.Effect<
              { purged: number },
              accountErasure.PulseErasureDbError,
              never
            >,
          );
          return { ok: true as const, purged: result.purged };
        } catch {
          set.status = 500;
          return { error: "internal_error" };
        }
      },
      {
        body: t.Object({
          accountId: t.String({ minLength: 1 }),
          profileIds: t.Array(t.String({ minLength: 1 }), { maxItems: 50 }),
        }),
      },
    );

export const internalRoutes = createInternalRoutes();
