import { chatMembers, chats, messages } from "@zap/db/schema";
import { DbLive, Db, type Db as DbType } from "@zap/db/service";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";

import {
  PERMITTED_INBOUND_SCOPES,
  ServiceKeyMismatchError,
  registerServiceKey,
  requireArc,
  revokeServiceKey,
} from "../lib/arc-middleware";
import { MAX_CHAT_MEMBERS, MAX_EXPORT_PROFILE_IDS } from "../lib/limits";
import { provisionC2bChat } from "../services/chats";
import { sendC2bMessage, listC2bMessages } from "../services/messages";

const AUDIENCE = "zap-api";
const SCOPE_ACCOUNT_EXPORT = "account:export";
// Bounds the DSAR c2b-body fetch to keep the export within Worker memory/CPU.
// A follow-up may paginate if a real account exceeds this.
const MAX_EXPORT_C2B_MESSAGES = 5_000;

function isTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Use a constant-time loop in lieu of Buffer.timingSafeEqual to keep
  // this lib browser/Workers-portable. JS strings are immutable so we can
  // XOR-accumulate both inputs.
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * A single DSAR export line: `{"section": "...", "record": {...}}`.
 * NDJSON — one JSON object per line, `application/x-ndjson`.
 */
interface ExportChatMemberRecord {
  readonly chatId: string;
  readonly role: string;
  readonly joinedAt: string | null;
}

/**
 * Reads the caller's chat memberships for the DSAR export. Message CONTENT
 * (`messages.ciphertext`) is deliberately NOT read — the export surfaces only
 * membership metadata (which chats a profile belongs to, its role, and when it
 * joined), never the E2E-encrypted message bodies.
 */
const loadChatMemberships = (
  profileIds: readonly string[],
): Effect.Effect<ExportChatMemberRecord[], never, DbType> =>
  Effect.gen(function* () {
    if (profileIds.length === 0) return [];
    const { db } = yield* Db;
    const rows = yield* Effect.promise(
      (): Promise<{ chatId: string; role: string; joinedAt: Date | null }[]> =>
        db
          .select({
            chatId: chatMembers.chatId,
            role: chatMembers.role,
            joinedAt: chatMembers.joinedAt,
          })
          .from(chatMembers)
          .where(inArray(chatMembers.profileId, [...profileIds])) as Promise<
          { chatId: string; role: string; joinedAt: Date | null }[]
        >,
    );
    return rows.map((r) => ({
      chatId: r.chatId,
      role: r.role,
      joinedAt: r.joinedAt ? r.joinedAt.toISOString() : null,
    }));
  }).pipe(Effect.withSpan("zap.internal.account_export"));

/**
 * A single DSAR export line for a c2b (server-visible) message body.
 * `messages.ciphertext` is NEVER read here — only `body` is selected.
 */
interface ExportC2bMessageRecord {
  readonly chatId: string;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * Reads c2b message bodies for all c2b chats the exported profiles are members
 * of. `messages.ciphertext` is deliberately NOT selected — c2c ciphertext
 * stays excluded from all DSAR exports.
 *
 * Scope: chats.class = 'c2b' AND chatMembers.profileId IN profileIds.
 */
const loadC2bMessages = (
  profileIds: readonly string[],
): Effect.Effect<ExportC2bMessageRecord[], never, DbType> =>
  Effect.gen(function* () {
    if (profileIds.length === 0) return [];
    const { db } = yield* Db;
    // Single 3-table join replaces the old two-query pair (c2b chat ids for
    // the profiles, then messages by `inArray(messages.chatId, c2bChatIds)`)
    // — the second query's `IN` list was unbounded in parameters, so a
    // profile in more than ~100 c2b chats failed the export outright. Only
    // `profileIds` is bound here.
    // Read only `body` — never `ciphertext` or `nonce`.
    // isNotNull(body): defence-in-depth — only c2b bodies, never a stray null.
    // groupBy(messages.id), not DISTINCT: the join duplicates a message row
    // when two exported profiles share a chat. DISTINCT applies to the
    // *projected* columns, and the projection deliberately has no
    // `messages.id` — two genuinely different messages in the same chat with
    // the same body and the same second-resolution `createdAt` would collapse
    // into one and the data subject would silently lose a message. Grouping
    // by a non-projected column (the message's own primary key) is valid
    // SQLite and keeps them apart.
    // orderBy + limit: bounds the fetch to keep the export within Worker memory/CPU.
    const msgRows = yield* Effect.promise(
      (): Promise<{ chatId: string; body: string; createdAt: Date }[]> =>
        db
          .select({
            chatId: messages.chatId,
            body: messages.body,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .innerJoin(chatMembers, eq(chatMembers.chatId, messages.chatId))
          .innerJoin(chats, and(eq(chats.id, messages.chatId), eq(chats.class, "c2b")))
          .where(and(inArray(chatMembers.profileId, [...profileIds]), isNotNull(messages.body)))
          .groupBy(messages.id)
          .orderBy(desc(messages.createdAt))
          .limit(MAX_EXPORT_C2B_MESSAGES) as Promise<
          { chatId: string; body: string; createdAt: Date }[]
        >,
    );
    return msgRows.map((r) => ({
      chatId: r.chatId,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
    }));
  }).pipe(Effect.withSpan("zap.internal.account_export_c2b_messages"));

/**
 * Internal zap-api endpoints — ARC-gated (account-export) and
 * shared-secret-gated (register-service / service-keys/:keyId revoke).
 */
export const createInternalRoutes = (dbLayer: Layer.Layer<DbType> = DbLive) => {
  // Layer graph built once per factory (convention: build the runtime once,
  // never per request) — mirrors pulse/api's internal router.
  const runtime = ManagedRuntime.make(dbLayer);
  return (
    new Elysia({ prefix: "/internal" })
      // ------------------------------------------------------------------
      // ARC public-key registration. Mirrors osn-api's
      // /graph/internal/register-service. osn-api calls this on startup with
      // the shared INTERNAL_SERVICE_SECRET to register the outbound key it
      // will use when fanning out a DSAR export to Zap.
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
              // Persist only the permitted subset (defence in depth — the
              // check above already rejects any unknown scope).
              allowedScopes: requestedScopes.join(","),
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
      // ARC-gated `/internal/account-export` — called by osn-api when
      // fanning out a DSAR account export (C-H1). Returns NDJSON: one
      // `{"section":"zap.chats","record":{...}}` line per chat membership of
      // the supplied profile IDs. Message content is EXCLUDED.
      // ------------------------------------------------------------------
      .post(
        "/account-export",
        async ({ body, headers, set }) => {
          const caller = await requireArc(
            headers.authorization,
            set,
            AUDIENCE,
            SCOPE_ACCOUNT_EXPORT,
          );
          if (!caller) return { error: "Unauthorized" };

          // Bound at the boundary rather than letting D1 fail the export: each
          // profile id is one bound parameter in the `inArray(...)` clauses
          // both loaders below build, so an unbounded list risks D1's
          // ~100-bound-parameter ceiling per query.
          if (body.profile_ids.length > MAX_EXPORT_PROFILE_IDS) {
            set.status = 400;
            return { error: `profile_ids exceeds max of ${MAX_EXPORT_PROFILE_IDS}` };
          }

          const [membershipRecords, c2bMessageRecords] = await runtime.runPromise(
            Effect.all([loadChatMemberships(body.profile_ids), loadC2bMessages(body.profile_ids)]),
          );

          // Buffered NDJSON — one JSON object per line, no trailing newline
          // beyond each record's own. Empty profile set → empty body.
          const ndjsonLines: string[] = [
            ...membershipRecords.map((record) => JSON.stringify({ section: "zap.chats", record })),
            ...c2bMessageRecords.map((record) =>
              JSON.stringify({ section: "zap.c2b_messages", record }),
            ),
          ];
          const ndjson = ndjsonLines.join("\n");

          set.status = 200;
          set.headers["content-type"] = "application/x-ndjson";
          return ndjson;
        },
        {
          body: t.Object({
            account_id: t.String(),
            profile_ids: t.Array(t.String()),
          }),
        },
      )
      // ------------------------------------------------------------------
      // ARC-gated `/internal/chats` — called by cire-api to provision
      // consumer-to-business chats (scope: `chat:c2b`).
      // ------------------------------------------------------------------
      .post(
        "/chats",
        async ({ body, headers, set }) => {
          const caller = await requireArc(headers.authorization, set, AUDIENCE, "chat:c2b");
          if (!caller) return { error: "Unauthorized" };

          const result = await runtime.runPromise(
            provisionC2bChat({
              memberProfileIds: body.memberProfileIds,
              createdByProfileId: body.createdByProfileId,
              title: body.title,
            }).pipe(
              Effect.catchTag("ValidationError", () =>
                Effect.sync(() => {
                  set.status = 400;
                  return { error: "Invalid request" } as const;
                }),
              ),
              Effect.catchTag("DatabaseError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal server error" } as const;
                }),
              ),
            ),
          );
          if ("error" in result) return result;
          set.status = 201;
          return { chatId: result.id };
        },
        {
          body: t.Object({
            memberProfileIds: t.Array(t.String(), { minItems: 2, maxItems: MAX_CHAT_MEMBERS }),
            createdByProfileId: t.String({ minLength: 1 }),
            title: t.Optional(t.String()),
          }),
        },
      )
      // ------------------------------------------------------------------
      // ARC-gated `POST /internal/chats/:chatId/messages` — send a
      // server-visible (plaintext) message into a c2b chat.
      // ------------------------------------------------------------------
      .post(
        "/chats/:chatId/messages",
        async ({ body, headers, params, set }) => {
          const caller = await requireArc(headers.authorization, set, AUDIENCE, "chat:c2b");
          if (!caller) return { error: "Unauthorized" };

          const result = await runtime.runPromise(
            sendC2bMessage(params.chatId, body.senderProfileId, { body: body.body }).pipe(
              Effect.catchTag("ValidationError", () =>
                Effect.sync(() => {
                  set.status = 400;
                  return { error: "Invalid request" } as const;
                }),
              ),
              Effect.catchTag("ChatNotFound", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "Chat not found" } as const;
                }),
              ),
              Effect.catchTag("NotC2bChat", () =>
                Effect.sync(() => {
                  set.status = 409;
                  return { error: "Not a c2b chat" } as const;
                }),
              ),
              Effect.catchTag("NotChatMember", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { error: "Sender is not a chat member" } as const;
                }),
              ),
              Effect.catchTag("DatabaseError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal server error" } as const;
                }),
              ),
            ),
          );
          if ("error" in result) return result;
          set.status = 201;
          return {
            messageId: result.id,
            createdAt: result.createdAt.toISOString(),
          };
        },
        {
          params: t.Object({ chatId: t.String({ minLength: 1 }) }),
          body: t.Object({
            senderProfileId: t.String({ minLength: 1 }),
            body: t.String({ minLength: 1 }),
          }),
        },
      )
      // ------------------------------------------------------------------
      // ARC-gated `GET /internal/chats/:chatId/messages` — list messages
      // in a c2b chat (newest first, cursor-paginated via `before` + `limit`).
      // ------------------------------------------------------------------
      .get(
        "/chats/:chatId/messages",
        async ({ headers, params, query, set }) => {
          const caller = await requireArc(headers.authorization, set, AUDIENCE, "chat:c2b");
          if (!caller) return { error: "Unauthorized" };

          const limit = query.limit;
          const before = query.before ?? undefined;

          const result = await runtime.runPromise(
            listC2bMessages(params.chatId, { limit, before }).pipe(
              // An unknown `before` cursor. Reported rather than silently
              // restarting at page 1, which would send the caller round the
              // same page for ever.
              //
              // 400, not the 422 the public `/chats` routes answer for the
              // same condition. That split is deliberate and it is per
              // surface, not per condition: every `ValidationError` on this
              // ARC-gated internal API is a 400 (see the message-send route
              // above), and every one on the public API is a 422. One
              // consumer reads this surface, and a caller that talked to both
              // would otherwise have to branch on which is which anyway —
              // what costs is the rule being unwritten, not the rule.
              Effect.catchTag("ValidationError", () =>
                Effect.sync(() => {
                  set.status = 400;
                  return { error: "Invalid cursor" } as const;
                }),
              ),
              Effect.catchTag("ChatNotFound", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { error: "Chat not found" } as const;
                }),
              ),
              Effect.catchTag("NotC2bChat", () =>
                Effect.sync(() => {
                  set.status = 409;
                  return { error: "Not a c2b chat" } as const;
                }),
              ),
              Effect.catchTag("DatabaseError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal server error" } as const;
                }),
              ),
            ),
          );
          if ("error" in result) return result;
          return {
            messages: result.map((m) => ({
              id: m.id,
              senderProfileId: m.senderProfileId,
              body: m.body ?? "",
              createdAt: m.createdAt.toISOString(),
            })),
          };
        },
        {
          params: t.Object({ chatId: t.String({ minLength: 1 }) }),
          query: t.Object({
            limit: t.Optional(t.Numeric()),
            before: t.Optional(t.String()),
          }),
        },
      )
  );
};
