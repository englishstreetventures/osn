import { extractClaims } from "@shared/osn-auth-client/verify";
import { createRateLimiter, getClientIp, type RateLimiterBackend } from "@shared/rate-limit";
import { DbLive, type Db } from "@zap/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { DEFAULT_JWKS_URL } from "../lib/jwks";
import { MAX_CHAT_MEMBERS, MAX_CIPHERTEXT_LENGTH, MAX_NONCE_LENGTH } from "../lib/limits";
import { metricAccessDenied } from "../metrics";
import {
  createChat,
  getChat,
  listChats,
  updateChat,
  addMember,
  removeMember,
  getChatMembers,
  assertMember,
} from "../services/chats";
import { sendMessage, listMessages } from "../services/messages";

const chatTypeEnum = t.Union([t.Literal("dm"), t.Literal("group"), t.Literal("event")]);

/** Audience expected on user access tokens minted by osn/api. */
const ACCESS_AUDIENCE = "osn-access";

/**
 * AUDIT-Z2 chokepoint. Verifies a Bearer token via the OSN JWKS (ES256) and
 * returns the actor's `profileId` ONLY when the verified `sub` is a real OSN
 * user id (prefix `usr_`).
 *
 * A verified-but-malformed `sub` (e.g. an org or service principal that
 * somehow held an `osn-access` token) must never be written into
 * `created_by_profile_id` / `sender_profile_id`, so every route derives its
 * actor id through this single helper. Decision: prefix-only check (not a
 * strict regex) — the issuer already guarantees the id shape; this is a cheap
 * defence-in-depth guard.
 *
 * Returns `null` on any verification failure OR a non-`usr_` sub; callers map
 * `null` to a uniform 401.
 */
async function resolveProfileId(
  authHeader: string | undefined,
  jwksUrl: string,
  testKey: CryptoKey | undefined,
): Promise<{ profileId: string } | null> {
  const claims = await extractClaims(authHeader, jwksUrl, {
    testKey: testKey as CryptoKey,
    audience: ACCESS_AUDIENCE,
  });
  if (!claims) return null;
  if (!claims.profileId.startsWith("usr_")) return null;
  return { profileId: claims.profileId };
}

/** Rate limiter configuration for Zap write endpoints. */
export interface ZapRateLimiters {
  /** POST /chats — 20 req/IP/min */
  readonly createChat: RateLimiterBackend;
  /** POST /chats/:id/messages — 60 req/IP/min */
  readonly sendMessage: RateLimiterBackend;
  /** POST /chats/:id/members — 30 req/IP/min */
  readonly addMember: RateLimiterBackend;
}

export function createDefaultZapRateLimiters(): ZapRateLimiters {
  return {
    createChat: createRateLimiter({ maxRequests: 20, windowMs: 60_000 }),
    sendMessage: createRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    addMember: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
  };
}

export const createChatsRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
  rateLimiters: ZapRateLimiters = createDefaultZapRateLimiters(),
) => {
  return (
    new Elysia({ prefix: "/chats" })
      // ── List user's chats ─────────────────────────────────────────────
      .get("/", async ({ headers, set }) => {
        const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const result = await Effect.runPromise(
          listChats(claims.profileId).pipe(Effect.provide(dbLayer)),
        );
        return { chats: result };
      })
      // ── Get chat by ID ────────────────────────────────────────────────
      .get(
        "/:id",
        async ({ params, headers, set }) => {
          const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const chat = yield* getChat(params.id);
              yield* assertMember(params.id, claims.profileId);
              return chat;
            }).pipe(
              Effect.catchTag("ChatNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotChatMember", () => Effect.succeed(null)),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            metricAccessDenied("chat", "not_found");
            set.status = 404;
            return { message: "Chat not found" };
          }
          return { chat: result };
        },
        { params: t.Object({ id: t.String() }) },
      )
      // ── Create chat ───────────────────────────────────────────────────
      .post(
        "/",
        async ({ body, headers, set }) => {
          const ip = getClientIp(headers);
          if (!(await rateLimiters.createChat.check(ip))) {
            set.status = 429;
            return { message: "Too many requests" } as const;
          }
          const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            createChat(body, claims.profileId).pipe(
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.catchTag("InvalidDmMembership", () =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: "A DM must have exactly two members" } as const;
                }),
              ),
              Effect.catchTag("ConsentDenied", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { error: "Not permitted to message this profile" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if ("error" in result) return result;
          set.status = 201;
          return { chat: result };
        },
        {
          body: t.Object({
            type: chatTypeEnum,
            title: t.Optional(t.String()),
            eventId: t.Optional(t.String()),
            memberProfileIds: t.Optional(t.Array(t.String(), { maxItems: MAX_CHAT_MEMBERS })),
          }),
        },
      )
      // ── Update chat ───────────────────────────────────────────────────
      .patch(
        "/:id",
        async ({ params, body, headers, set }) => {
          const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              yield* assertMember(params.id, claims.profileId);
              return yield* updateChat(params.id, body, claims.profileId);
            }).pipe(
              Effect.catchTag("ChatNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotChatMember", () => Effect.succeed(null)),
              Effect.catchTag("NotChatAdmin", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Chat not found" };
          }
          if ("error" in result || "message" in result) return result;
          return { chat: result };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ title: t.Optional(t.String()) }),
        },
      )
      // ── Get members ───────────────────────────────────────────────────
      .get(
        "/:id/members",
        async ({ params, headers, set }) => {
          const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              yield* assertMember(params.id, claims.profileId);
              return yield* getChatMembers(params.id);
            }).pipe(
              Effect.catchTag("ChatNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotChatMember", () => Effect.succeed(null)),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Chat not found" };
          }
          return { members: result };
        },
        { params: t.Object({ id: t.String() }) },
      )
      // ── Add member ────────────────────────────────────────────────────
      .post(
        "/:id/members",
        async ({ params, body, headers, set }) => {
          const ip = getClientIp(headers);
          if (!(await rateLimiters.addMember.check(ip))) {
            set.status = 429;
            return { message: "Too many requests" } as const;
          }
          const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            addMember(params.id, body.profileId, claims.profileId).pipe(
              Effect.catchTag("ChatNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotChatAdmin", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
              Effect.catchTag("MemberLimitReached", () =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: "Member limit reached" } as const;
                }),
              ),
              Effect.catchTag("AlreadyMember", () =>
                Effect.sync(() => {
                  set.status = 409;
                  return { error: "Already a member" } as const;
                }),
              ),
              Effect.catchTag("InvalidDmMembership", () =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: "Cannot add members to a DM" } as const;
                }),
              ),
              Effect.catchTag("ConsentDenied", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { error: "Not permitted to add this profile" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Chat not found" };
          }
          if ("error" in result || "message" in result) return result;
          set.status = 201;
          return { member: result };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ profileId: t.String() }),
        },
      )
      // ── Remove member ─────────────────────────────────────────────────
      .delete(
        "/:id/members/:profileId",
        async ({ params, headers, set }) => {
          const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            removeMember(params.id, params.profileId, claims.profileId).pipe(
              Effect.map(() => ({ ok: true }) as const),
              Effect.catchTag("ChatNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotChatAdmin", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
              Effect.catchTag("NotChatMember", () =>
                Effect.sync(() => {
                  set.status = 404;
                  return { message: "Not a member" } as const;
                }),
              ),
              Effect.catchTag("LastAdmin", () =>
                Effect.sync(() => {
                  set.status = 409;
                  return { message: "Cannot remove the last admin" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Chat not found" };
          }
          if ("message" in result) return result;
          set.status = 204;
          return null;
        },
        { params: t.Object({ id: t.String(), profileId: t.String() }) },
      )
      // ── Send message ──────────────────────────────────────────────────
      .post(
        "/:id/messages",
        async ({ params, body, headers, set }) => {
          const ip = getClientIp(headers);
          if (!(await rateLimiters.sendMessage.check(ip))) {
            set.status = 429;
            return { message: "Too many requests" } as const;
          }
          const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            sendMessage(params.id, claims.profileId, body).pipe(
              Effect.catchTag("ChatNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotChatMember", () =>
                Effect.sync(() => {
                  metricAccessDenied("messages", "not_member");
                  set.status = 403;
                  return { message: "Not a member" } as const;
                }),
              ),
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Chat not found" };
          }
          if ("error" in result || "message" in result) return result;
          set.status = 201;
          return { message: result };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            ciphertext: t.String({ maxLength: MAX_CIPHERTEXT_LENGTH }),
            nonce: t.String({ maxLength: MAX_NONCE_LENGTH }),
          }),
        },
      )
      // ── List messages ─────────────────────────────────────────────────
      .get(
        "/:id/messages",
        async ({ params, query, headers, set }) => {
          const claims = await resolveProfileId(headers["authorization"], jwksUrl, _testKey);
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            listMessages(params.id, claims.profileId, {
              limit: query.limit ? Number(query.limit) : undefined,
              cursor: query.cursor,
            }).pipe(
              Effect.catchTag("ChatNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotChatMember", () =>
                Effect.sync(() => {
                  metricAccessDenied("messages", "not_member");
                  set.status = 403;
                  return { message: "Not a member" } as const;
                }),
              ),
              Effect.catchTag("ValidationError", () =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: "Invalid cursor" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Chat not found" };
          }
          if (!Array.isArray(result) && ("message" in result || "error" in result)) return result;
          return { messages: result };
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({
            limit: t.Optional(t.String()),
            cursor: t.Optional(t.String()),
          }),
        },
      )
  );
};

export const chatsRoutes = createChatsRoutes();
