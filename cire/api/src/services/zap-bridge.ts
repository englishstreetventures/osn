import { importKeyFromJwk, signArcToken } from "@shared/crypto/jwk";
import { instrumentedFetch } from "@shared/observability/fetch";

/**
 * Server-to-server bridge to zap-api for the vendor enquiry c2b chat flow.
 * The ONLY file in cire/api that makes an outbound S2S call to zap-api.
 *
 * Mirrors `osn-bridge.ts` exactly: same base-URL trim, same `signArcToken` mint
 * per call, same `instrumentedFetch` default, same `fromEnv` key-import → null
 * on missing/corrupt pattern. The deltas: audience `"zap-api"`, scope
 * `"chat:c2b"`, three methods (provisionC2bChat / sendC2bMessage /
 * listC2bMessages) instead of one.
 *
 * Key distribution: cire reuses its existing ES256 private key
 * (`CIRE_API_ARC_PRIVATE_KEY` wrangler secret + `CIRE_API_ARC_KEY_ID`) — same
 * issuer key, new audience + scope. No new key env vars are added.
 *
 * `fetchImpl` on `createZapChatClient` exists ONLY so tests can inject a fake
 * fetch; production callers pass nothing and the client uses `instrumentedFetch`.
 * `createZapChatClientFromEnv` returns `null` (never throws) when any required
 * piece is absent or the JWK is corrupt — a missing config disables the feature,
 * never crashes boot.
 */

const ARC_ISSUER = "cire-api";
const ARC_AUDIENCE = "zap-api";
const ARC_SCOPE = "chat:c2b";

/**
 * zap-api serializes message `createdAt` as an ISO 8601 **string**
 * (`Date.toISOString()`); our public contract is epoch **milliseconds** (a
 * `number`, consumed downstream by PR C). Normalize at this bridge boundary so
 * `MessageDto.createdAt` genuinely holds a number. A wire value that is already
 * numeric is passed through defensively; anything unparseable falls back to
 * `0` rather than leaking a `NaN` into the DTO.
 */
function toEpochMs(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ZapChatClient {
  provisionC2bChat(input: {
    memberProfileIds: string[];
    createdByProfileId: string;
    title?: string;
  }): Promise<{ chatId: string }>;
  sendC2bMessage(
    chatId: string,
    input: { senderProfileId: string; body: string },
  ): Promise<{ messageId: string; createdAt: number }>;
  listC2bMessages(
    chatId: string,
    opts?: { limit?: number; before?: number },
  ): Promise<{
    messages: Array<{ id: string; senderProfileId: string; body: string; createdAt: number }>;
  }>;
}

export interface ZapChatClientConfig {
  /** Base URL of zap-api (trailing slash is trimmed automatically). */
  zapApiUrl: string;
  /** cire-api's ARC signing key, already imported from its JWK. */
  arcPrivateKey: CryptoKey;
  /** The `kid` matching the public key registered with zap-api. */
  arcKeyId: string;
  /**
   * Injectable fetch implementation — exists ONLY for tests. Production code
   * passes nothing and the client falls back to `instrumentedFetch` so every
   * outbound request carries a W3C `traceparent`.
   */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createZapChatClient(config: ZapChatClientConfig): ZapChatClient {
  const base = config.zapApiUrl.replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? instrumentedFetch;

  async function mint(): Promise<string> {
    return signArcToken(config.arcPrivateKey, {
      iss: ARC_ISSUER,
      aud: ARC_AUDIENCE,
      scope: ARC_SCOPE,
      kid: config.arcKeyId,
    });
  }

  async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const token = await mint();
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `ARC ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`zap-api ${method} ${path} returned ${res.status}`);
    }
    return res.json();
  }

  return {
    async provisionC2bChat(input) {
      const data = (await send("POST", "/internal/chats", {
        class: "c2b",
        memberProfileIds: input.memberProfileIds,
        createdByProfileId: input.createdByProfileId,
        ...(input.title === undefined ? {} : { title: input.title }),
      })) as { chatId: string };
      return { chatId: data.chatId };
    },

    async sendC2bMessage(chatId, input) {
      // zap wires `createdAt` as an ISO string — normalize to epoch ms here.
      const data = (await send("POST", `/internal/chats/${encodeURIComponent(chatId)}/messages`, {
        senderProfileId: input.senderProfileId,
        body: input.body,
      })) as { messageId: string; createdAt: string | number };
      return { messageId: data.messageId, createdAt: toEpochMs(data.createdAt) };
    },

    async listC2bMessages(chatId, opts) {
      const params = new URLSearchParams();
      if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts?.before !== undefined) params.set("before", String(opts.before));
      const qs = params.toString();
      const path = `/internal/chats/${encodeURIComponent(chatId)}/messages${qs ? `?${qs}` : ""}`;
      // zap wires each `createdAt` as an ISO string — normalize to epoch ms here.
      const data = (await send("GET", path)) as {
        messages: Array<{
          id: string;
          senderProfileId: string;
          body: string;
          createdAt: string | number;
        }>;
      };
      return {
        messages: data.messages.map((m) => ({
          id: m.id,
          senderProfileId: m.senderProfileId,
          body: m.body,
          createdAt: toEpochMs(m.createdAt),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Env-based factory (boot-safe)
// ---------------------------------------------------------------------------

/**
 * Builds a {@link ZapChatClient} from raw env material (JWK string + kid +
 * base URL), importing the ES256 private key. Returns `null` when:
 * - any of `zapApiUrl` / `arcPrivateKeyJwk` / `arcKeyId` is absent, or
 * - the JWK string is present but corrupt / invalid.
 *
 * A `null` return disables the vendor-enquiry chat feature (the route answers
 * 503) instead of crashing boot — mirrors `createAccountResolverFromEnv` and
 * `createHandleResolverFromEnv` in `osn-bridge.ts`. A malformed secret once
 * took down the whole organiser dashboard; this guard prevents that recurrence.
 *
 * Reuses cire-api's existing ARC key env vars (`CIRE_API_ARC_PRIVATE_KEY` /
 * `CIRE_API_ARC_KEY_ID`) — no new key env vars are introduced.
 */
export async function createZapChatClientFromEnv(env: {
  zapApiUrl?: string;
  arcPrivateKeyJwk?: string;
  arcKeyId?: string;
}): Promise<ZapChatClient | null> {
  if (!env.zapApiUrl || !env.arcPrivateKeyJwk || !env.arcKeyId) {
    return null;
  }
  // Present-but-INVALID key ⇒ degrade like absent (vendor chat disabled, route
  // answers 503) instead of throwing on every request. Same pattern as
  // createAccountResolverFromEnv's `.catch(() => null)`.
  const arcPrivateKey = await importKeyFromJwk(env.arcPrivateKeyJwk).catch(() => null);
  if (!arcPrivateKey) return null;
  return createZapChatClient({
    zapApiUrl: env.zapApiUrl,
    arcPrivateKey,
    arcKeyId: env.arcKeyId,
  });
}
