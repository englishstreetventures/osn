# Vendors S4 — PR B (cire-api enquiry backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cire-api enquiry BFF — `vendor_enquiries` metadata, couple + vendor routes, the outbound ARC S2S client to zap-api's c2b endpoints, transactional emails, quote→Budget, spam limiters, and compliance docs — so a couple can contact a directory vendor in-platform, hold a persistent thread stored in Zap, and turn a quote into a Budget line.

**Architecture:** cire-api is the BFF/orchestrator. It owns enquiry metadata (linkage + status + structured quote) in cire-db; message bodies live in Zap (the c2b chat class shipped in PR A #286), reached over an ARC S2S bridge (`chat:c2b` scope, audience `zap-api`). The `host.` and `vendor.` frontends (PR C) talk only to cire-api. Strictly pre-contractual — no booking/payment, DSA Art.30 stays out of scope.

**Tech Stack:** cire/api (Elysia on CF Workers, `aot:false`, Effect + D1/Drizzle), cire/db (Drizzle + drizzle-kit + the DDL-lockstep contract), `@shared/crypto/jwk` (ARC signing), `@shared/email` (transactional templates), `@shared/observability/fetch`.

## Global Constraints

- **Two design decisions locked (2026-07-21):**
  - **Vendor-side chat member = the claiming profile.** S3's `consumeClaim` is extended to record `directory_vendors.claimed_by_profile_id`. The enquiry's vendor-side c2b member is that profile. No osn-api change.
  - **Unclaimed listing → buffer first message in cire, flush on claim.** An enquiry to a listing with no `claimed_by_profile_id` is created with its first message in `vendor_enquiries.pending_body`; `zap_chat_id` stays null. When the vendor claims, cire provisions the c2b chat (couple + vendor) and flushes `pending_body` into Zap. While unprovisioned, couple replies are rejected (409 `awaiting_vendor`).
- **cire is version-less** (ignored by changesets). `@shared/email` is versioned (0.3.4). Never mix ignored + versioned packages in one changeset file — the `@shared/email` bump is its own changeset.
- **DDL-LOCKSTEP invariant:** every cire schema change touches THREE surfaces that must stay identical — `cire/db/src/schema.ts` (Drizzle), a new `cire/db/migrations/00NN_*.sql` (drizzle-kit generated), and the raw DDL string in `cire/api/src/db/setup.ts`. `cire/api/src/db/ddl-lockstep.test.ts` mechanically enforces all three. The next migration number is **0043** (latest is `0042_wedding_entitlements.sql`).
- **Money is integer minor units** (`*_minor`), never floats. Nullable when unset.
- **Effect idiom:** services return `Effect.Effect<A, E, DbService>`; tagged errors via `Data.TaggedError`; DB calls wrapped in the file's `dbQuery`/`Effect.tryPromise` helper; `.pipe(Effect.withSpan("cire.<area>.<fn>"))` on every service fn. No thrown exceptions in services. Frontends never import Effect (PR C).
- **ARC outbound:** mint with `signArcToken(privateKey, { iss: "cire-api", aud: "zap-api", scope: "chat:c2b", kid })` from `@shared/crypto/jwk`; call `${ZAP_API_URL}/internal/...` with header `Authorization: ARC <token>`. Reuse cire-api's existing ARC key (`CIRE_API_ARC_PRIVATE_KEY` + `CIRE_API_ARC_KEY_ID`) — same issuer key, new audience/scope. Degrade to a disabled client (feature 503s, never boot-crash) when config is absent, mirroring `osn-bridge.ts`.
- **NO prod actions in this PR.** The cire-api↔zap-api ARC service registration (cire registers its ARC public key with zap-api's `POST /internal/register-service`, `allowedScopes: "chat:c2b"`) is a **post-merge, user-authorized deploy-time step** — documented in the runbook, executed by a human. The plan writes config + docs only.
- **Cross-tenant scoping:** every couple route re-scopes by `weddingId` (via the wedding gates); every vendor route re-scopes by the enquiry's listing `owner_org_id` vs the caller's org membership. A mismatch is a **404** (no enumeration), mirroring S1–S3.
- **Compliance:** DSA Art.30 out of scope (pre-contractual). Enquiry bodies are server-visible personal data — record data-map + retention rows. Both thread UIs carry a "not end-to-end encrypted" notice (PR C copy; the compliance rows land here).

---

## File Structure

**cire/db (Task 1):**
- `cire/db/src/schema.ts` — add `vendorEnquiries` table; add `leadForwardEmail` + `claimedByProfileId` to `directoryVendors`.
- `cire/db/migrations/0043_vendor_enquiries.sql` — drizzle-kit generated.

**cire/api (Tasks 2, 4, 5, 6):**
- `cire/api/src/db/setup.ts` — mirror the new table + columns in the raw DDL string (lockstep).
- `cire/api/src/services/zap-bridge.ts` — NEW: outbound ARC client to zap-api (`provisionC2bChat`, `sendC2bMessage`, `listC2bMessages`).
- `cire/api/src/services/enquiries.ts` — NEW: the enquiry BFF service (open/reply/quote/addToBudget/list/getMessages/onVendorClaimed).
- `cire/api/src/routes/organiser-enquiries.ts` — NEW: couple-side routes.
- `cire/api/src/routes/vendor-enquiries.ts` — NEW: vendor-side routes.
- `cire/api/src/routes/vendor-portal.ts` — MODIFY: on `consumeClaim`, record `claimed_by_profile_id` + trigger the enquiry flush.
- `cire/api/src/services/directory.ts` — MODIFY: `consumeClaim` persists the claiming profile id.
- `cire/api/src/index.ts` — MODIFY: `Env` gains `ZAP_API_URL`; build the zap client at boot; pass it + the enquiry deps into `createApp`.
- `cire/api/src/app.ts` — MODIFY: wire the two new route factories + thread the zap client / limiter deps.
- `cire/api/wrangler.toml` — MODIFY: add `ZAP_API_URL` to `[vars]` + `[env.production.vars]`.

**@shared/email (Task 3):**
- `shared/email/src/templates/enquiry.ts` — NEW: three renderers.
- `shared/email/src/templates/index.ts` — MODIFY: register templates in the union, data map, dispatch switch.

**Docs + changeset (Task 7):**
- `wiki/apps/cire.md` — enquiries section.
- `wiki/runbooks/production-deploy.md` — cire↔zap ARC registration (deploy-time, authorized).
- `wiki/compliance/scope-matrix.md`, `wiki/compliance/data-map.md`, `wiki/compliance/retention.md` — Art.30 out-of-scope + c2b-body rows.
- `.changeset/vendor-enquiries-email.md` — `@shared/email` minor.

---

## Task 1: `vendor_enquiries` table + `directory_vendors` new columns (schema + migration + DDL lockstep)

**Files:**
- Modify: `cire/db/src/schema.ts`
- Generate: `cire/db/migrations/0043_vendor_enquiries.sql`
- Modify: `cire/api/src/db/setup.ts`
- Test: `cire/api/src/db/ddl-lockstep.test.ts` (existing — must stay green)

**Interfaces:**
- Produces: `vendorEnquiries` Drizzle table + inferred row type; `directoryVendors.leadForwardEmail` (text, nullable), `directoryVendors.claimedByProfileId` (text, nullable). Enquiry status enum `'open' | 'quoted' | 'closed'`, default `'open'`. `UNIQUE(wedding_id, directory_vendor_id)`.

- [ ] **Step 1: Add the two `directory_vendors` columns in `schema.ts`**

In `cire/db/src/schema.ts`, in the `directoryVendors` table object (currently ending `listed: text("listed").notNull().default("draft")`), add these two columns immediately before `createdAt`:

```typescript
    // The vendor's own CRM lead-capture address; cire also notifies it on a new
    // enquiry (a separate copy, not a BCC — keeps the address off the vendor
    // thread email). Null until the vendor sets it in the portal.
    leadForwardEmail: text("lead_forward_email"),
    // The OSN profile that claimed this listing (recorded at consumeClaim time).
    // Becomes the vendor-side member of any c2b enquiry chat. Null until claimed.
    claimedByProfileId: text("claimed_by_profile_id"),
```

- [ ] **Step 2: Add the `vendorEnquiries` table in `schema.ts`**

In `cire/db/src/schema.ts`, after the `vendors` table definition, add. Follow the existing conventions exactly (`integer(..., { mode: "timestamp" })`, `.references(() => weddings.id, { onDelete: "cascade" })`, `uniqueIndex`, `sql` import already present):

```typescript
export const vendorEnquiries = sqliteTable(
  "vendor_enquiries",
  {
    id: text("id").primaryKey(), // enq_<uuid>
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    // The directory listing enquired. No FK cascade: a listing outliving a
    // wedding is fine; the wedding cascade above is the lifecycle owner.
    directoryVendorId: text("directory_vendor_id").notNull(),
    // The couple's CRM row (created-if-missing on open) — ties status/quote back
    // into the S1 Vendors module.
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    // The provisioned Zap c2b chat. Null until provisioned (unclaimed listing:
    // provisioning is deferred to claim time; the first message waits in
    // `pendingBody`).
    zapChatId: text("zap_chat_id"),
    // Buffered first message for an enquiry whose chat isn't provisioned yet.
    // Flushed into Zap + nulled when the vendor claims. Exactly one of
    // (zapChatId set) / (pendingBody set) holds for an open enquiry.
    pendingBody: text("pending_body"),
    status: text("status", { enum: ["open", "quoted", "closed"] })
      .notNull()
      .default("open"),
    createdBy: text("created_by").notNull(), // osn profile id of the organiser
    quotedMinor: integer("quoted_minor"), // latest quote; mirrors vendors.quoted_minor
    lastMessageAt: integer("last_message_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // One thread per (wedding, listing) — the idempotency key for open.
    uniqueIndex("vendor_enquiries_wedding_directory_uniq").on(t.weddingId, t.directoryVendorId),
    // Couple inbox: newest-first per wedding.
    index("vendor_enquiries_wedding_last_msg_idx").on(t.weddingId, t.lastMessageAt),
    // Vendor inbox: find a listing's enquiries.
    index("vendor_enquiries_directory_idx").on(t.directoryVendorId),
  ],
);
```

- [ ] **Step 3: Generate the migration**

Run: `bun run --cwd cire/db db:generate`
Expected: `cire/db/migrations/0043_vendor_enquiries.sql` appears, plus a `meta/` snapshot update. Inspect the `.sql`: it must `CREATE TABLE vendor_enquiries` (with the FK to weddings + vendors, the unique index, the two other indexes) and `ALTER TABLE directory_vendors ADD lead_forward_email` + `ADD claimed_by_profile_id`. If drizzle-kit prompts interactively, it should not for pure additive changes; if the generated file name differs, rename it to `0043_vendor_enquiries.sql` and keep the `--> statement-breakpoint` separators drizzle wrote.

- [ ] **Step 4: Mirror the DDL in `setup.ts` (lockstep)**

In `cire/api/src/db/setup.ts`, in the `DDL` string: (a) add `lead_forward_email TEXT` and `claimed_by_profile_id TEXT` to the `CREATE TABLE ... directory_vendors (...)` block; (b) add the new table + its indexes. Match the generated migration's shape exactly (column order matters less — the lockstep test normalises order — but names/types/constraints must match). Add after the `vendors` DDL block:

```sql
CREATE TABLE IF NOT EXISTS vendor_enquiries (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  directory_vendor_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  zap_chat_id TEXT,
  pending_body TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  quoted_minor INTEGER,
  last_message_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_enquiries_wedding_directory_uniq ON vendor_enquiries(wedding_id, directory_vendor_id);
CREATE INDEX IF NOT EXISTS vendor_enquiries_wedding_last_msg_idx ON vendor_enquiries(wedding_id, last_message_at);
CREATE INDEX IF NOT EXISTS vendor_enquiries_directory_idx ON vendor_enquiries(directory_vendor_id);
```

And in the `directory_vendors` CREATE block, add before `created_at INTEGER NOT NULL`:

```sql
  lead_forward_email TEXT,
  claimed_by_profile_id TEXT,
```

- [ ] **Step 5: Run the lockstep + db suites — expect PASS**

Run: `bun run --cwd cire/api test:run -- ddl-lockstep` then `bun run --cwd cire/db test:run`
Expected: PASS. The lockstep test applies the full migration chain to one in-memory DB and the `setup.ts` DDL to another and diffs a normalised structural snapshot. If it fails, the diff message names the mismatched table/column/index — fix `setup.ts` or the migration to match `schema.ts`, do not touch the test.

- [ ] **Step 6: Commit**

```bash
git add cire/db/src/schema.ts cire/db/migrations cire/api/src/db/setup.ts
git commit -m "feat(cire): vendor_enquiries table + directory_vendors lead_forward/claimed_by columns"
```

---

## Task 2: cire→zap ARC S2S client (`zap-bridge.ts`)

**Files:**
- Create: `cire/api/src/services/zap-bridge.ts`
- Create: `cire/api/src/services/zap-bridge.test.ts`
- Modify: `cire/api/src/index.ts` (add `ZAP_API_URL` to `Env`)

**Interfaces:**
- Consumes: `signArcToken` + `importKeyFromJwk` from `@shared/crypto/jwk`; `instrumentedFetch` from `@shared/observability/fetch`.
- Produces:
  - `interface ZapChatClient { provisionC2bChat(input: { memberProfileIds: string[]; createdByProfileId: string; title?: string }): Promise<{ chatId: string }>; sendC2bMessage(chatId: string, input: { senderProfileId: string; body: string }): Promise<{ messageId: string; createdAt: number }>; listC2bMessages(chatId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: Array<{ id: string; senderProfileId: string; body: string; createdAt: number }> }>; }`
  - `function createZapChatClient(config: { zapApiUrl: string; arcPrivateKey: CryptoKey; arcKeyId: string; fetchImpl?: typeof fetch }): ZapChatClient`
  - `function createZapChatClientFromEnv(env: { zapApiUrl?: string; arcPrivateKeyJwk?: string; arcKeyId?: string }): Promise<ZapChatClient | null>` — returns `null` when any piece is absent or the JWK is corrupt (feature disabled, no boot crash). The `fetchImpl` param exists ONLY for tests; production passes nothing and the client uses `instrumentedFetch`.

**Reference to mirror:** `cire/api/src/services/osn-bridge.ts` — copy the `createArcOrgMembershipResolver` + `createAccountResolverFromEnv` shape (base-URL trim, token mint, `instrumentedFetch`, status handling, `fromEnv` key import with try/catch → null). The deltas: audience `"zap-api"`, scope `"chat:c2b"`, three methods instead of one, POST/GET bodies.

- [ ] **Step 1: Write the failing test**

Create `cire/api/src/services/zap-bridge.test.ts`. Use a fake `fetchImpl` that records the request and returns canned JSON — this avoids any network + verifies the ARC header + URL + body shaping. Generate a real ES256 key so `signArcToken` produces a verifiable token (we only assert the header is present + `ARC `-prefixed).

```typescript
import { describe, it, expect } from "bun:test";
import { generateKeyPair, exportJWK } from "jose";
import { createZapChatClient } from "./zap-bridge";

async function testKey() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return privateKey;
}

function fakeFetch(status: number, json: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("zap-bridge createZapChatClient", () => {
  it("provisionC2bChat POSTs to /internal/chats with an ARC header + returns chatId", async () => {
    const { impl, calls } = fakeFetch(201, { chatId: "cht_123" });
    const client = createZapChatClient({
      zapApiUrl: "https://zap.example/",
      arcPrivateKey: await testKey(),
      arcKeyId: "kid_test",
      fetchImpl: impl,
    });
    const res = await client.provisionC2bChat({
      memberProfileIds: ["usr_a", "usr_b"],
      createdByProfileId: "usr_a",
      title: "Vendor ↔ Wedding",
    });
    expect(res.chatId).toBe("cht_123");
    expect(calls[0].url).toBe("https://zap.example/internal/chats");
    const auth = new Headers(calls[0].init?.headers).get("authorization") ?? "";
    expect(auth.startsWith("ARC ")).toBe(true);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      class: "c2b",
      memberProfileIds: ["usr_a", "usr_b"],
      createdByProfileId: "usr_a",
      title: "Vendor ↔ Wedding",
    });
  });

  it("sendC2bMessage POSTs the body + returns messageId/createdAt", async () => {
    const { impl, calls } = fakeFetch(201, { messageId: "msg_9", createdAt: 1700 });
    const client = createZapChatClient({
      zapApiUrl: "https://zap.example",
      arcPrivateKey: await testKey(),
      arcKeyId: "kid_test",
      fetchImpl: impl,
    });
    const res = await client.sendC2bMessage("cht_123", { senderProfileId: "usr_a", body: "hi" });
    expect(res).toEqual({ messageId: "msg_9", createdAt: 1700 });
    expect(calls[0].url).toBe("https://zap.example/internal/chats/cht_123/messages");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ senderProfileId: "usr_a", body: "hi" });
  });

  it("listC2bMessages GETs with limit/before query + returns messages", async () => {
    const { impl, calls } = fakeFetch(200, { messages: [{ id: "m1", senderProfileId: "usr_a", body: "hi", createdAt: 1 }] });
    const client = createZapChatClient({
      zapApiUrl: "https://zap.example",
      arcPrivateKey: await testKey(),
      arcKeyId: "kid_test",
      fetchImpl: impl,
    });
    const res = await client.listC2bMessages("cht_123", { limit: 20, before: 999 });
    expect(res.messages).toHaveLength(1);
    expect(calls[0].url).toBe("https://zap.example/internal/chats/cht_123/messages?limit=20&before=999");
  });

  it("throws on a non-2xx zap response", async () => {
    const { impl } = fakeFetch(500, { error: "boom" });
    const client = createZapChatClient({
      zapApiUrl: "https://zap.example",
      arcPrivateKey: await testKey(),
      arcKeyId: "kid_test",
      fetchImpl: impl,
    });
    await expect(
      client.provisionC2bChat({ memberProfileIds: ["a", "b"], createdByProfileId: "a" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --cwd cire/api test:run -- zap-bridge`
Expected: FAIL — `./zap-bridge` module / `createZapChatClient` not found.

- [ ] **Step 3: Implement `zap-bridge.ts`**

Create `cire/api/src/services/zap-bridge.ts`. Match the exact signatures in Interfaces. Key points: trim trailing slashes off `zapApiUrl`; `fetchImpl ?? instrumentedFetch`; mint a fresh token per call with `signArcToken(arcPrivateKey, { iss: "cire-api", aud: "zap-api", scope: "chat:c2b", kid: arcKeyId })`; header `authorization: \`ARC ${token}\``; JSON bodies; on `!res.ok` throw `new Error(\`zap-api <METHOD> <path> returned ${res.status}\`)`. `createZapChatClientFromEnv` returns `null` if `zapApiUrl`/`arcPrivateKeyJwk`/`arcKeyId` missing, and wraps `importKeyFromJwk(JSON.parse(arcPrivateKeyJwk))` in try/catch → `null`.

```typescript
import { importKeyFromJwk, signArcToken } from "@shared/crypto/jwk";
import { instrumentedFetch } from "@shared/observability/fetch";

const ARC_ISSUER = "cire-api";
const ARC_AUDIENCE = "zap-api";
const ARC_SCOPE = "chat:c2b";

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
  ): Promise<{ messages: Array<{ id: string; senderProfileId: string; body: string; createdAt: number }> }>;
}

export interface ZapChatClientConfig {
  zapApiUrl: string;
  arcPrivateKey: CryptoKey;
  arcKeyId: string;
  fetchImpl?: typeof fetch;
}

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
    if (!res.ok) throw new Error(`zap-api ${method} ${path} returned ${res.status}`);
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
      const data = (await send("POST", `/internal/chats/${encodeURIComponent(chatId)}/messages`, {
        senderProfileId: input.senderProfileId,
        body: input.body,
      })) as { messageId: string; createdAt: number };
      return { messageId: data.messageId, createdAt: data.createdAt };
    },
    async listC2bMessages(chatId, opts) {
      const params = new URLSearchParams();
      if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts?.before !== undefined) params.set("before", String(opts.before));
      const qs = params.toString();
      const path = `/internal/chats/${encodeURIComponent(chatId)}/messages${qs ? `?${qs}` : ""}`;
      const data = (await send("GET", path)) as {
        messages: Array<{ id: string; senderProfileId: string; body: string; createdAt: number }>;
      };
      return { messages: data.messages };
    },
  };
}

export async function createZapChatClientFromEnv(env: {
  zapApiUrl?: string;
  arcPrivateKeyJwk?: string;
  arcKeyId?: string;
}): Promise<ZapChatClient | null> {
  if (!env.zapApiUrl || !env.arcPrivateKeyJwk || !env.arcKeyId) return null;
  try {
    const arcPrivateKey = await importKeyFromJwk(JSON.parse(env.arcPrivateKeyJwk));
    return createZapChatClient({
      zapApiUrl: env.zapApiUrl,
      arcPrivateKey,
      arcKeyId: env.arcKeyId,
    });
  } catch {
    return null;
  }
}
```

> Implementer note: confirm the exact export names in `@shared/crypto/jwk` (`signArcToken`, `importKeyFromJwk`) and `@shared/observability/fetch` (`instrumentedFetch`) match how `osn-bridge.ts` imports them; if a name differs, use the one `osn-bridge.ts` actually imports and adjust the test's expectations for the ARC header accordingly (the header must still be `ARC <token>`).

- [ ] **Step 4: Add `ZAP_API_URL` to the `Env` interface**

In `cire/api/src/index.ts`, in the `Env` interface, add alongside the existing `OSN_API_URL?: string;`:

```typescript
  ZAP_API_URL?: string;
```

(The ARC key + kid are already present as `CIRE_API_ARC_PRIVATE_KEY` / `CIRE_API_ARC_KEY_ID` — reused, not re-added.)

- [ ] **Step 5: Run — expect PASS + typecheck**

Run: `bun run --cwd cire/api test:run -- zap-bridge` then `bun run --cwd cire/api check` (or `bun run check` scoped to cire/api).
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add cire/api/src/services/zap-bridge.ts cire/api/src/services/zap-bridge.test.ts cire/api/src/index.ts
git commit -m "feat(cire): cire→zap ARC S2S client for c2b chat provision + message CRUD"
```

---

## Task 3: enquiry email templates (`@shared/email`)

**Files:**
- Create: `shared/email/src/templates/enquiry.ts`
- Modify: `shared/email/src/templates/index.ts`
- Test: `shared/email/src/templates/enquiry.test.ts` (create)

**Interfaces:**
- Produces three `EmailTemplate` names + their data shapes:
  - `"enquiry-new"`: `{ vendorName: string; weddingName: string; message: string; threadUrl: string; unclaimed: boolean; claimUrl?: string }` → vendor "new enquiry" (if `unclaimed`, adds the "claim your listing to reply" CTA using `claimUrl`).
  - `"enquiry-reply"`: `{ recipientName: string; senderName: string; message: string; threadUrl: string }` → "new reply".
  - `"enquiry-quote"`: `{ vendorName: string; amountFormatted: string; note?: string; threadUrl: string }` → couple "you received a quote".

- [ ] **Step 1: Write the failing render tests**

Create `shared/email/src/templates/enquiry.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { renderTemplate } from "./index";

describe("enquiry email templates", () => {
  it("enquiry-new (claimed) omits the claim CTA and includes the message + thread url", () => {
    const r = renderTemplate("enquiry-new", {
      vendorName: "Bloom Co",
      weddingName: "Sam & Alex",
      message: "Are you free June 2027?",
      threadUrl: "https://host.example/enquiries/enq_1",
      unclaimed: false,
    });
    expect(r.subject).toContain("Sam & Alex");
    expect(r.text).toContain("Are you free June 2027?");
    expect(r.text).toContain("https://host.example/enquiries/enq_1");
    expect(r.text).not.toContain("Claim your listing");
  });

  it("enquiry-new (unclaimed) includes the claim CTA + claimUrl", () => {
    const r = renderTemplate("enquiry-new", {
      vendorName: "Bloom Co",
      weddingName: "Sam & Alex",
      message: "Hi",
      threadUrl: "https://host.example/enquiries/enq_1",
      unclaimed: true,
      claimUrl: "https://vendor.example/claim/tok_9",
    });
    expect(r.text).toContain("Claim your listing");
    expect(r.text).toContain("https://vendor.example/claim/tok_9");
  });

  it("enquiry-quote formats the amount + optional note", () => {
    const r = renderTemplate("enquiry-quote", {
      vendorName: "Bloom Co",
      amountFormatted: "$1,200.00",
      note: "Includes delivery",
      threadUrl: "https://host.example/enquiries/enq_1",
    });
    expect(r.subject).toContain("quote");
    expect(r.text).toContain("$1,200.00");
    expect(r.text).toContain("Includes delivery");
  });

  it("escapes HTML in user-supplied fields", () => {
    const r = renderTemplate("enquiry-reply", {
      recipientName: "Bloom Co",
      senderName: "Sam & Alex",
      message: "<script>alert(1)</script>",
      threadUrl: "https://host.example/enquiries/enq_1",
    });
    expect(r.html).not.toContain("<script>alert(1)</script>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --cwd shared/email test:run -- enquiry` (or `bun test` in `shared/email`).
Expected: FAIL — templates not registered (`renderTemplate` throws / returns undefined for the new names).

- [ ] **Step 3: Implement the renderers + register them**

Create `shared/email/src/templates/enquiry.ts`. Mirror the structure of `shared/email/src/templates/vendor-claim.ts` (the `esc()` escaper + `wrap()` HTML shell — import them if exported there, else re-declare the same two helpers locally). Each renderer returns `{ subject, text, html }` (`RenderedEmail`). The unclaimed branch appends the claim CTA paragraph + `claimUrl`.

```typescript
import type { RenderedEmail } from "./index";

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export interface EnquiryNewData {
  readonly vendorName: string;
  readonly weddingName: string;
  readonly message: string;
  readonly threadUrl: string;
  readonly unclaimed: boolean;
  readonly claimUrl?: string;
}

export function renderEnquiryNew(data: EnquiryNewData): RenderedEmail {
  const subject = `New enquiry from ${data.weddingName}`;
  const claimTextBlock =
    data.unclaimed && data.claimUrl
      ? [``, `Claim your listing to reply and manage your enquiries:`, data.claimUrl]
      : [``, `Reply to this enquiry:`, data.threadUrl];
  const text = [
    `Hi ${data.vendorName},`,
    ``,
    `${data.weddingName} sent you an enquiry on Cire Weddings:`,
    ``,
    data.message,
    ...claimTextBlock,
    ``,
    `— Cire Weddings`,
  ].join("\n");
  const claimHtmlBlock =
    data.unclaimed && data.claimUrl
      ? `<p>Claim your listing to reply and manage your enquiries:</p><p><a href="${esc(data.claimUrl)}">Claim your listing</a></p>`
      : `<p><a href="${esc(data.threadUrl)}">Reply to this enquiry</a></p>`;
  const html = wrap(
    `<h2>New enquiry from ${esc(data.weddingName)}</h2>` +
      `<p>Hi ${esc(data.vendorName)},</p>` +
      `<p>${esc(data.weddingName)} sent you an enquiry on Cire Weddings:</p>` +
      `<blockquote>${esc(data.message)}</blockquote>` +
      claimHtmlBlock,
  );
  return { subject, text, html };
}

export interface EnquiryReplyData {
  readonly recipientName: string;
  readonly senderName: string;
  readonly message: string;
  readonly threadUrl: string;
}

export function renderEnquiryReply(data: EnquiryReplyData): RenderedEmail {
  const subject = `New reply from ${data.senderName}`;
  const text = [
    `Hi ${data.recipientName},`,
    ``,
    `${data.senderName} replied to your enquiry thread:`,
    ``,
    data.message,
    ``,
    `View the thread: ${data.threadUrl}`,
    ``,
    `— Cire Weddings`,
  ].join("\n");
  const html = wrap(
    `<h2>New reply from ${esc(data.senderName)}</h2>` +
      `<p>Hi ${esc(data.recipientName)},</p>` +
      `<blockquote>${esc(data.message)}</blockquote>` +
      `<p><a href="${esc(data.threadUrl)}">View the thread</a></p>`,
  );
  return { subject, text, html };
}

export interface EnquiryQuoteData {
  readonly vendorName: string;
  readonly amountFormatted: string;
  readonly note?: string;
  readonly threadUrl: string;
}

export function renderEnquiryQuote(data: EnquiryQuoteData): RenderedEmail {
  const subject = `You received a quote from ${data.vendorName}`;
  const text = [
    `${data.vendorName} sent you a quote: ${data.amountFormatted}`,
    ...(data.note ? [``, data.note] : []),
    ``,
    `View the quote: ${data.threadUrl}`,
    ``,
    `This quote is informational — no booking or payment happens on Cire.`,
    ``,
    `— Cire Weddings`,
  ].join("\n");
  const html = wrap(
    `<h2>You received a quote from ${esc(data.vendorName)}</h2>` +
      `<p><strong>${esc(data.amountFormatted)}</strong></p>` +
      (data.note ? `<blockquote>${esc(data.note)}</blockquote>` : ``) +
      `<p><a href="${esc(data.threadUrl)}">View the quote</a></p>` +
      `<p style="color:#666;font-size:13px">This quote is informational — no booking or payment happens on Cire.</p>`,
  );
  return { subject, text, html };
}
```

Then in `shared/email/src/templates/index.ts`: (a) add the three names to the `EmailTemplate` union; (b) add their data shapes to `EmailTemplateDataMap` (import the `EnquiryNewData`/`EnquiryReplyData`/`EnquiryQuoteData` types or inline the same shapes); (c) add three `case` arms to the `renderTemplate` switch calling `renderEnquiryNew`/`renderEnquiryReply`/`renderEnquiryQuote`. If `RenderedEmail` is not currently exported from `index.ts`, export it (the new `enquiry.ts` imports it).

- [ ] **Step 4: Run — expect PASS**

Run: `bun run --cwd shared/email test:run` (full — the template registry is shared).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/email/src/templates/enquiry.ts shared/email/src/templates/index.ts shared/email/src/templates/enquiry.test.ts
git commit -m "feat(email): enquiry-new / enquiry-reply / enquiry-quote templates"
```

---

## Task 4: enquiry BFF service (`enquiries.ts`)

**Files:**
- Create: `cire/api/src/services/enquiries.ts`
- Create: `cire/api/src/services/enquiries.test.ts`

**Interfaces:**
- Consumes: `DbService` + `dbQuery` (the file-local Effect DB helper — copy the import pattern from `cire/api/src/services/budget.ts`); the `vendors`, `vendorEnquiries`, `directoryVendors`, `budgetItems` tables from `@cire/db/schema` (or the local `../db` re-export used elsewhere); `vendorsService.create` (from `./vendors`) for create-if-missing CRM rows; `budgetService.createItem` (from `./budget`) for quote→budget; a `ZapChatClient` (Task 2) and an email sender, both injected (NOT imported as singletons — pass them into the service factory so tests stub them).
- Produces `createEnquiryService(deps: { zap: ZapChatClient | null; sendEmail: (msg: SendEmailInput) => Effect.Effect<void, never, never>; threadBaseUrl: string })` returning an object with:
  - `open(input: { weddingId: string; weddingName: string; directoryVendorId: string; category: string; message: string; createdBy: string; vendorEmail: string | null; leadForwardEmail: string | null; claimUrl: string }): Effect.Effect<EnquiryDto, EnquiryError, DbService>` — see Flow below. (`vendorEmail`/`leadForwardEmail`/`claimUrl` are supplied by the route so the service stays host-agnostic; when unclaimed, cire also sends a separate copy to `leadForwardEmail` if set — a copy, not a BCC, keeping that address off the vendor thread email.)
  - `list(weddingId: string): Effect.Effect<EnquiryListItem[], never, DbService>`
  - `getMessages(enquiry: EnquiryRow): Effect.Effect<MessageDto[], EnquiryError, DbService>`
  - `reply(input: { enquiry: EnquiryRow; senderProfileId: string; senderName: string; recipientEmail: string | null; recipientName: string; message: string }): Effect.Effect<MessageDto, EnquiryError, DbService>`
  - `quote(input: { enquiry: EnquiryRow; senderProfileId: string; amountMinor: number; note?: string; coupleEmail: string | null; vendorName: string; currency: string }): Effect.Effect<EnquiryDto, EnquiryError, DbService>`
  - `addToBudget(input: { enquiry: EnquiryRow; vendorName: string; category: string }): Effect.Effect<{ budgetItemId: string }, EnquiryError, DbService>`
  - `onVendorClaimed(input: { directoryVendorId: string; vendorProfileId: string }): Effect.Effect<void, never, DbService>` — flush buffered enquiries (see Flow).
- Tagged errors: `EnquiryNotFound`, `EnquiryAwaitingVendor` (reply attempted before provision), `ZapUnavailable` (deps.zap is null), all via `Data.TaggedError`.

**Flows (spec §5):**
- **open:** (1) create-if-missing the `vendors` CRM row via `vendorsService.create({ weddingId, name: listing.name, category, status: "researching", contactName: null, email: listing.email, phone: listing.phone, notes: null, quotedMinor: null, directoryVendorId })` — the `vendors_wedding_directory_uniq` partial index dedups; on a unique-violation, SELECT the existing row instead. (2) Idempotency: SELECT `vendor_enquiries` by `(weddingId, directoryVendorId)`; if it exists, return it (repeat enquiry reuses the thread — do NOT re-provision or re-email). (3) Resolve the listing's `claimedByProfileId`. If set AND `deps.zap` non-null → `zap.provisionC2bChat({ memberProfileIds: [createdBy, claimedByProfileId], createdByProfileId: createdBy, title: weddingName })` then `zap.sendC2bMessage(chatId, { senderProfileId: createdBy, body: message })`; store `zapChatId`, `pendingBody: null`. Else (unclaimed) → `zapChatId: null`, `pendingBody: message`. (4) INSERT the enquiry row (`id: enq_<uuid>`, `status: "open"`, `lastMessageAt: now`). (5) Email the vendor via `sendEmail` (`enquiry-new`, `unclaimed` = !claimedByProfileId, `claimUrl` when unclaimed — see route for URL construction; the service takes `vendorEmail`, `leadForwardEmail`, `claimUrl` in the input so it can send). (6) Return DTO.
- **reply:** if `enquiry.zapChatId` is null → fail `EnquiryAwaitingVendor` (409 `awaiting_vendor`). Else `zap.sendC2bMessage`, bump `lastMessageAt`/`updatedAt`, email the other party (`enquiry-reply`), return the message DTO.
- **getMessages:** if `zapChatId` set → `zap.listC2bMessages` mapped to DTOs. If null but `pendingBody` set → return a single synthesized DTO `{ id: "pending", senderProfileId: enquiry.createdBy, body: pendingBody, createdAt: enquiry.createdAt }` so the couple sees their unsent-to-vendor first message.
- **quote:** UPDATE `vendor_enquiries.quotedMinor` + `status = "quoted"`; UPDATE the linked `vendors.quotedMinor`; `zap.sendC2bMessage(chatId, { senderProfileId, body: "Quote: <amountFormatted>\n<note>" })`; email the couple (`enquiry-quote`). Fail `EnquiryAwaitingVendor` if `zapChatId` null (a quote presupposes a claimed vendor, so this should never happen, but guard it).
- **addToBudget:** `budgetService.createItem({ weddingId, category, name: vendorName, estimateMinor: null, quotedMinor: enquiry.quotedMinor, actualMinor: null, notes: null })`; return `{ budgetItemId }`.
- **onVendorClaimed:** SELECT open enquiries with `directoryVendorId = input.directoryVendorId AND zapChatId IS NULL AND pendingBody IS NOT NULL`. For each: `provisionC2bChat({ memberProfileIds: [enquiry.createdBy, vendorProfileId], createdByProfileId: enquiry.createdBy, title })` → `sendC2bMessage(chatId, { senderProfileId: enquiry.createdBy, body: pendingBody })` → UPDATE `zapChatId`, `pendingBody: null`, bump `lastMessageAt`. If `deps.zap` is null, no-op (log a warning). This is best-effort per enquiry — one failure must not abort the claim; wrap each in `Effect.catchAll` → log.

- [ ] **Step 1: Write failing service tests**

Create `cire/api/src/services/enquiries.test.ts`. Use the same in-memory DB harness the other cire service tests use (`createDb(":memory:")` + `seedDb` from `../db/setup`, run effects with the file's runner providing `DbService`). Inject a **fake `ZapChatClient`** (records calls, returns canned ids) and a **fake `sendEmail`** (records the `SendEmailInput`s, returns `Effect.void`). Seed a `directory_vendors` listing (one claimed with `claimedByProfileId`, one unclaimed) before each test. Cover:

```typescript
// (Names illustrative — follow the real harness in vendors.test.ts / budget.test.ts.)
it("open() on a CLAIMED listing provisions a chat, sends the first message, emails the vendor", async () => {
  // fakeZap.provisionC2bChat called with [createdBy, claimedByProfileId]; sendC2bMessage called with body;
  // enquiry row has zapChatId set, pendingBody null, status 'open';
  // a 'vendors' CRM row was created with directoryVendorId set;
  // sendEmail received an 'enquiry-new' with unclaimed:false.
});

it("open() on an UNCLAIMED listing buffers pendingBody, leaves zapChatId null, emails with claim CTA", async () => {
  // fakeZap.provisionC2bChat NOT called; enquiry.pendingBody === message; zapChatId null;
  // sendEmail 'enquiry-new' unclaimed:true with a claimUrl.
});

it("open() is idempotent on (weddingId, directoryVendorId) — repeat reuses the thread, no second provision/email", async () => {
  // second open() returns the same enquiry id; fakeZap.provisionC2bChat call count stays 1 (claimed case);
  // sendEmail call count stays 1.
});

it("reply() on an unprovisioned enquiry fails EnquiryAwaitingVendor", async () => { /* zapChatId null → 409 tag */ });

it("reply() on a provisioned enquiry sends to zap + emails the other party", async () => { /* ... */ });

it("getMessages() returns the synthesized pending message when unprovisioned", async () => {
  // single DTO with body === pendingBody, id 'pending'.
});

it("quote() sets vendor_enquiries.quotedMinor AND vendors.quotedMinor, status 'quoted', emails couple", async () => {
  // assert BOTH tables updated; sendEmail 'enquiry-quote' with formatted amount.
});

it("addToBudget() inserts a budget_items row with quotedMinor from the enquiry", async () => {
  // budget_items row: name === vendorName, category, quotedMinor === enquiry.quotedMinor.
});

it("onVendorClaimed() provisions + flushes each buffered enquiry, nulling pendingBody", async () => {
  // after: enquiry.zapChatId set, pendingBody null; fakeZap.sendC2bMessage called with the buffered body.
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --cwd cire/api test:run -- enquiries`
Expected: FAIL — `createEnquiryService` not defined.

- [ ] **Step 3: Implement `enquiries.ts`**

Implement `createEnquiryService` per the Interfaces + Flows. Mirror `budget.ts` for the Effect/`dbQuery`/`withSpan`/`crypto.randomUUID` idiom (`enq_${crypto.randomUUID()}` ids). Amount formatting for emails: a small `formatMinor(minor, currency)` helper (or reuse an existing one — check `cire/api/src/lib` for a money formatter before writing a new one; if none, `new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100)`). Keep the vendor-email address + claim URL as inputs the ROUTE supplies (the service stays URL/host-agnostic apart from `threadBaseUrl`).

- [ ] **Step 4: Run — expect PASS**

Run: `bun run --cwd cire/api test:run -- enquiries`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/services/enquiries.ts cire/api/src/services/enquiries.test.ts
git commit -m "feat(cire): enquiry BFF service — open/reply/quote/addToBudget/flush-on-claim"
```

---

## Task 5: couple-side routes (`/api/organiser/weddings/:weddingId/enquiries`)

**Files:**
- Create: `cire/api/src/routes/organiser-enquiries.ts`
- Create: `cire/api/src/routes/organiser-enquiries.test.ts`
- Modify: `cire/api/src/app.ts` (wire the factory), `cire/api/src/index.ts` (build deps + limiter)

**Interfaces:**
- Consumes: `osnAuth(osnAuthOptions)`, `weddingMember(db)` (read), `weddingEditor(db)` (write) from the middleware dir; `rateLimitMiddlewareByUser(limiter)`; `createEnquiryService` (Task 4). The enquiry service's `zap`/`sendEmail`/`threadBaseUrl` deps are built in `index.ts` and passed through `app.ts` into the factory.
- Produces route factory `createOrganiserEnquiriesRoutes(db, osnAuthOptions, deps: { enquiryService, limiter })`, prefix `/api/organiser`, group `/weddings/:weddingId`:
  - `GET /enquiries` (weddingMember) → `{ enquiries: EnquiryListItem[] }` (CRM linkage + last-message preview + status + quotedMinor).
  - `GET /enquiries/:id/messages` (weddingMember) → `{ messages: MessageDto[] }` (from Zap or the pending buffer). 404 if the enquiry isn't in this wedding.
  - `POST /enquiries` (weddingEditor, limiter) → open. Body `{ directoryVendorId: string; category: string; message: string }`. `201 { enquiry }`.
  - `POST /enquiries/:id/messages` (weddingEditor, limiter) → reply. Body `{ message: string }`. `201 { message }`. 409 `awaiting_vendor` if unprovisioned.
  - `POST /enquiries/:id/add-to-budget` (weddingEditor) → `201 { budgetItemId }`.
- Every handler re-loads the enquiry by id AND asserts `enquiry.weddingId === weddingId` → else 404 (cross-tenant).

- [ ] **Step 1: Write failing route tests**

Create `cire/api/src/routes/organiser-enquiries.test.ts`. Mirror `organiser-weddings.test.ts` harness: `makeOsnTestAuth()`, `buildApp()` (`createApp(db, { osnTestKey, orgMembership: stub, ...injected enquiry deps via a test option })`), `appRequest`. Because the enquiry deps (zap client, email) are injected, add a test hook to `createApp` options (e.g. `enquiryZapClient`, `enquiryEmailSender`) — see Step 3 for wiring; in tests pass fakes. Assert:

```typescript
it("GET /enquiries is 401 without a token", async () => { /* ... */ });
it("GET /enquiries lists only this wedding's enquiries (cross-tenant hidden)", async () => { /* ... */ });
it("POST /enquiries as a viewer co-host is 403 read_only_role", async () => { /* weddingEditor gate */ });
it("POST /enquiries opens a thread + is idempotent on repeat (same id, 200/201)", async () => { /* ... */ });
it("POST /enquiries/:id/messages on an unprovisioned enquiry → 409 awaiting_vendor", async () => { /* ... */ });
it("GET /enquiries/:id/messages for another wedding's enquiry → 404", async () => { /* cross-tenant */ });
it("POST /enquiries/:id/add-to-budget creates a budget item from the quote → 201", async () => { /* ... */ });
it("POST /enquiries is rate-limited per user (limiter maxRequests=1 → second 429)", async () => { /* ... */ });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --cwd cire/api test:run -- organiser-enquiries`
Expected: FAIL — factory/route not defined.

- [ ] **Step 3: Implement the routes + wire into the app**

Create `cire/api/src/routes/organiser-enquiries.ts` following `organiser-weddings.ts` (group under `/weddings/:weddingId`, `.use(weddingMember(db))` for the read group and a separate `.use(weddingEditor(db))` group for writes with `.use(rateLimitMiddlewareByUser(limiter))`; read `osnProfileId` + `weddingId` from context; parse bodies with Effect Schema `Schema.decodeUnknown` + `Effect.catchTag("ParseError", → 400)`). Map service tagged errors: `EnquiryNotFound`→404, `EnquiryAwaitingVendor`→409 `awaiting_vendor`, `ZapUnavailable`→503.

In `cire/api/src/app.ts`: accept the enquiry deps in `AppOptions` (`enquiryZapClient?: ZapChatClient | null`, `enquiryEmailSender?`, or a pre-built `enquiryService`), build the `enquiryService` once, and `.use(createOrganiserEnquiriesRoutes(db, osnAuthOptions, { enquiryService, limiter: enquiryLimiter }))`. In `cire/api/src/index.ts`: `const zap = await createZapChatClientFromEnv({ zapApiUrl: env.ZAP_API_URL, arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY, arcKeyId: env.CIRE_API_ARC_KEY_ID })`; build `sendEmail` from the existing `emailLayer` (wrap `EmailService.send` provided the layer, error channel `never`); define `const enquiryLimiter = createRateLimiter({ maxRequests: 20, windowMs: 60_000 })` (per-user, spam control §96); pass all into `createApp`. Keep everything degrade-safe: if `zap` is null the routes still mount (open/reply return 503 `ZapUnavailable`).

- [ ] **Step 4: Run — expect PASS**

Run: `bun run --cwd cire/api test:run -- organiser-enquiries` then the full cire/api suite `bun run --cwd cire/api test:run`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/routes/organiser-enquiries.ts cire/api/src/routes/organiser-enquiries.test.ts cire/api/src/app.ts cire/api/src/index.ts
git commit -m "feat(cire): couple-side enquiry routes (open/reply/messages/add-to-budget)"
```

---

## Task 6: vendor-side routes + claim-flush wiring

**Files:**
- Create: `cire/api/src/routes/vendor-enquiries.ts`
- Create: `cire/api/src/routes/vendor-enquiries.test.ts`
- Modify: `cire/api/src/services/directory.ts` (`consumeClaim` records `claimedByProfileId`)
- Modify: `cire/api/src/routes/vendor-portal.ts` (after `consumeClaim`, call `enquiryService.onVendorClaimed`)
- Modify: `cire/api/src/app.ts` (wire the vendor-enquiries factory + pass `enquiryService` to the portal)

**Interfaces:**
- Consumes: `osnAuth`, the `orgMembership(orgId, profileId): Promise<"admin"|"member"|null>` resolver (already an `AppOptions` dep used by `vendor-portal.ts`), `createEnquiryService` (Task 4). The vendor gate resolves the enquiry → its `directoryVendorId` → `directory_vendors.ownerOrgId`, then `orgMembership(ownerOrgId, osnProfileId)`; null → 404 (cross-tenant, no enumeration).
- Produces `createVendorEnquiriesRoutes(db, osnAuthOptions, deps: { enquiryService, orgMembership, limiter })`, prefix `/api/vendor`:
  - `GET /enquiries` → enquiries across the caller's claimed listings (join `directory_vendors` where `ownerOrgId` ∈ caller's orgs — resolve via `orgMembership` per listing, or filter by the caller's org set). `{ enquiries: [...] }`.
  - `GET /enquiries/:id/messages` → thread (org-scoped). 404 if not the caller's org.
  - `POST /enquiries/:id/messages` (limiter) → reply. `201 { message }`.
  - `POST /enquiries/:id/quote` (limiter) → structured quote. Body `{ amountMinor: number; note?: string }`. `201 { enquiry }`.
- `consumeClaim(token, orgId, claimingProfileId)` gains a third arg — the claiming profile — persisted to `directory_vendors.claimedByProfileId` in the same UPDATE that sets `ownerOrgId`.

- [ ] **Step 1: Write failing tests**

Create `cire/api/src/routes/vendor-enquiries.test.ts` (mirror `vendor-portal.test.ts` — `stubOrgMembership`, injected fakes). Also extend/parallel the directory service test for the claim change. Assert:

```typescript
it("GET /enquiries is 401 without a token", async () => { /* ... */ });
it("GET /enquiries/:id/messages for an enquiry outside the caller's org → 404", async () => { /* cross-tenant */ });
it("POST /enquiries/:id/quote sets vendors.quoted_minor + enquiry.quoted_minor, status quoted → 201", async () => { /* ... */ });
it("POST /enquiries/:id/messages appends a reply → 201", async () => { /* ... */ });
// directory / claim:
it("consumeClaim records claimed_by_profile_id alongside owner_org_id", async () => { /* ... */ });
it("claiming a listing flushes buffered enquiries: provisions chat + sends pending body", async () => {
  // seed an unclaimed listing + an open enquiry with pendingBody; consume the claim via the vendor-portal route;
  // assert the enquiry now has zapChatId set + pendingBody null (fake zap recorded the provision+send).
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --cwd cire/api test:run -- vendor-enquiries` and `bun run --cwd cire/api test:run -- directory`
Expected: FAIL — factory/route not defined; `consumeClaim` arity unchanged.

- [ ] **Step 3: Implement**

(a) `directory.ts`: add `claimingProfileId: string` param to `consumeClaim`; include `claimedByProfileId: claimingProfileId` in the UPDATE that binds `ownerOrgId`. Update its existing callers/tests to pass the profile (the vendor-portal claim handler has `osnProfileId` in scope).
(b) `vendor-portal.ts`: in the `POST /claims/:token/consume` handler, after `directoryService.consumeClaim(token, orgId, osnProfileId)` succeeds, call `enquiryService.onVendorClaimed({ directoryVendorId: listing.id, vendorProfileId: osnProfileId })` (best-effort; its error channel is `never`). Thread `enquiryService` in via `AppOptions`.
(c) `vendor-enquiries.ts`: the route factory + the enquiry→org gate helper (load enquiry → listing → `ownerOrgId` → `orgMembership` → 404 on null). Map tagged errors as in Task 5.
(d) `app.ts`: `.use(createVendorEnquiriesRoutes(db, osnAuthOptions, { enquiryService, orgMembership: vendorOrgMembership, limiter: enquiryLimiter }))` and pass `enquiryService` into `createVendorPortalRoutes`' deps.

- [ ] **Step 4: Run — expect PASS + full suite**

Run: `bun run --cwd cire/api test:run` (whole cire/api suite — this task touches shared wiring).
Expected: PASS (existing vendor-portal + directory tests updated for the new `consumeClaim` arity stay green).

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/routes/vendor-enquiries.ts cire/api/src/routes/vendor-enquiries.test.ts cire/api/src/services/directory.ts cire/api/src/routes/vendor-portal.ts cire/api/src/app.ts
git commit -m "feat(cire): vendor-side enquiry routes + quote + claim-flush of buffered enquiries"
```

---

## Task 7: config, compliance docs, wiki + changeset

**Files:**
- Modify: `cire/api/wrangler.toml`
- Modify: `wiki/apps/cire.md`, `wiki/runbooks/production-deploy.md`
- Modify: `wiki/compliance/scope-matrix.md`, `wiki/compliance/data-map.md`, `wiki/compliance/retention.md`
- Create: `.changeset/vendor-enquiries-email.md`

- [ ] **Step 1: Add `ZAP_API_URL` to `wrangler.toml`**

In `cire/api/wrangler.toml`, add to the top-level `[vars]` block:

```toml
ZAP_API_URL = "http://localhost:3002"
```

and to `[env.production.vars]`:

```toml
ZAP_API_URL = "https://zap.cireweddings.com"
```

(The ARC key/kid are already provided as Worker secrets — no wrangler change for those.)

- [ ] **Step 2: Document the cire↔zap ARC registration as a deploy-time step**

In `wiki/runbooks/production-deploy.md`, add a section **"cire→zap ARC registration (Vendors S4 PR B follow-up) — requires explicit authorization; prod writes."** Content: after zap-api is live (PR A bring-up), cire-api must register its ARC public key with zap-api so `chat:c2b` tokens verify — `POST https://zap.cireweddings.com/internal/register-service` authenticated with `INTERNAL_SERVICE_SECRET`, body `{ serviceId: "cire-api", publicKeyJwk: <cire-api ARC public JWK>, allowedScopes: "chat:c2b" }` (mirror the cire↔osn `org:read` registration already in this runbook). Note this is executed by a human, not CI, exactly like PR A's zap bring-up + migration 0042.

- [ ] **Step 3: Compliance rows**

- `wiki/compliance/scope-matrix.md`: record **DSA Art.30 = out of scope** for S4 (pre-contractual; no distance contract concluded on-platform) and note that an on-platform "book/accept" slice would trigger it.
- `wiki/compliance/data-map.md`: add rows for `cire.vendor_enquiries` (linkage + `pending_body` transient first message + `quoted_minor`) and cross-reference the Zap c2b message bodies (already server-visible personal data from PR A).
- `wiki/compliance/retention.md`: cire enquiry metadata cascades on `weddings.id` delete (FK `ON DELETE CASCADE`); Zap c2b bodies are covered by `account-export` (DSAR, PR A). Add the `lead_forward_email` as vendor-supplied contact PII.
- Update `last-reviewed` frontmatter on each touched wiki page to `2026-07-21`.

- [ ] **Step 4: `wiki/apps/cire.md` enquiries section**

Add a "Vendor enquiries (S4)" section: the BFF/orchestrator role, `vendor_enquiries` linkage, the c2b thread in Zap over ARC (`chat:c2b`, audience `zap-api`), the claimed/unclaimed (buffer→flush-on-claim) branch, quote→Budget, the per-user spam limiter, and the not-E2E notice (PR C). Update `last-reviewed: 2026-07-21`.

- [ ] **Step 5: Changeset**

Create `.changeset/vendor-enquiries-email.md`:

```markdown
---
"@shared/email": minor
---

Add enquiry transactional templates (enquiry-new, enquiry-reply, enquiry-quote) for cire Vendors S4 enquiries.
```

cire packages are version-less (changeset-ignored) — do NOT add `@cire/*` to this file. If `scripts/validate-changesets.sh` requires a changeset entry for the cire changes, create a SEPARATE empty/`@cire/api` version-less changeset per the existing cire convention (check how S3 / PR #283 handled it), never mixing it with the `@shared/email` bump.

- [ ] **Step 6: Validate + full checks**

Run: `bash scripts/validate-changesets.sh`, `bun run --cwd cire/api test:run`, `bun run --cwd cire/db test:run`, `bun run --cwd shared/email test:run`, `bun run lint`, `bun run fmt:check`.
Expected: all green. Fix any oxfmt findings with `bun run fmt` + re-stage.

- [ ] **Step 7: Commit**

```bash
git add cire/api/wrangler.toml wiki .changeset
git commit -m "docs(cire): enquiries wiki + compliance rows + cire↔zap ARC runbook + email changeset"
```

---

## Notes for the executor

- **After all tasks:** run `/prep-pr` (parallel perf + security/compliance reviews + structured PR body). Security emphasis: the enquiry routes are a new cross-tenant surface — confirm every couple route re-scopes by `weddingId` and every vendor route by the listing's `owner_org_id` (→ 404, no enumeration); confirm the ARC outbound client only ever mints `chat:c2b`/`aud: zap-api`; confirm `pending_body` can't leak across tenants and the reply/quote paths reject unprovisioned enquiries. Then `superpowers:finishing-a-development-branch` → push + open PR. **Do NOT merge**, and **do NOT** run the cire↔zap ARC registration or any prod step — those are the user-authorized deploy-time steps in the runbook.
- This is **PR B of 3** (spec §9). PR A (zap c2b infra) is already merged (#286). PR C = the `host.` + `vendor.` frontends (thread UI, quote card, add-to-budget, non-E2E notice). Do not build PR C here.
- **Injected deps, not singletons:** the enquiry service takes its `ZapChatClient` + email sender as constructor deps so route tests stub them. Do not import a module-level zap/email singleton into `enquiries.ts`.
</content>
</invoke>
