# cire Vendors S4 — Enquiries (design)

**Status:** approved (brainstorm 2026-07-19).

**Goal:** Let a couple contact a directory vendor **in-platform**, hold a persistent thread, and receive an informational **quote** that flows into the couple's Budget — keeping the enquiry attached to the wedding-management platform (where the AU directory incumbents just hand off to email and leave).

**Architecture:** cire-api is the **BFF/orchestrator**; **Zap** is the message store (a new server-visible **c2b** chat class) reached over an **ARC S2S** bridge; the `host.` and `vendor.` frontends talk **only to cire-api**. No Signal client, no WebSocket, no E2E for these commercial threads. Strictly **pre-contractual** (no on-platform booking/payment) → **DSA Art.30 stays out of scope**.

**Tech stack:** cire/api (Elysia on CF Workers + Effect + D1/Drizzle), cire/db, cire/organiser + cire/vendor (Astro + SolidJS), zap/api + zap/db (Elysia + Drizzle), `@shared/email`, `@shared/crypto` (ARC).

---

## 1. Market rationale (why this shape)

AU landscape splits in two:
- **Couple-side directories** (Easy Weddings, WedShed, Managing Matrimony): their "enquiry" is *an email to the vendor's inbox* — everyone then leaves the platform. cire wins by keeping the enquiry + quote tied to the couple's platform (Budget, Checklist, Vendor CRM).
- **Vendor-side booking tools** (Studio Ninja [AU hero], Dubsado; HoneyBook is US/CA-bank-locked): entrenched, vendors already pay for them, and **none expose a clean inbound API** (Studio Ninja isn't even on Zapier). Integration verdict: **don't build native connectors — the enquiry *email* is the integration** (it lands in the inbox that feeds their CRM), plus an optional per-listing lead-capture forwarding address. Zapier/outbound-webhook is a deferred power-user add-on.

**Consequences (locked decisions):** cire is **not** a vendor booking engine; S4 is **pre-contractual**; the vendor keeps their own CRM, fed by cire's email; native CRM integration is deferred.

## 2. Architecture & data flow

```
host. (couple)  ─┐                          ┌─ vendor. (vendor portal)
                 ├─►  cire-api  ──ARC S2S──► zap-api  ──► zap-db
 enquiries API   │  (enquiry BFF)            (generic c2b   (chats/messages,
 (weddingMember/ │  + @shared/email          chat provision  server-visible
  weddingEditor) │  + quote→Budget           + msg CRUD)      c2b body)
                 └─  (org-member gate, vendor side)
```

- Both frontends call **only cire-api**. cire-api relays every message to/from Zap over ARC S2S, owns the enquiry metadata, the email notifications, the spam limiter, and the quote→Budget action.
- **No Signal client / no WebSocket in the frontends.** Reads are on-load/poll for v1; real-time belongs to Zap's private-DM track later.
- **cire owns the couple relationship + wedding data; Zap owns "a thread between two OSN profiles."** Zap never learns about weddings/vendors/quotes; cire never reimplements message storage.

## 3. Zap side — generalized c2b/c2c (nothing cire-specific)

- `chats` gains **`class: 'c2c' | 'c2b'`** — **c2c** = consumer-to-consumer (personal, **E2E** ciphertext; existing `dm`/`group`), **c2b** = consumer-to-business (**server-visible** plaintext, moderatable). Encryption/visibility **derives from the class**. Existing `type` (dm/group/event) stays as cardinality/origin; dm/group default `c2c`; `event` is Pulse's to classify (leave as-is / Pulse decides).
- `messages` gains a nullable **`body`** (plaintext) column. Invariant: **c2b message → `body` set, `ciphertext`/`nonce` null**; c2c message → `ciphertext`/`nonce` (now nullable). Enforced app-layer.
- **Generic ARC-gated `/internal` endpoints** (no "enquiry" anywhere):
  - `POST /internal/chats` — provision a chat: `{ class, memberProfileIds[], createdByProfileId, title? }` → `{ chatId }`.
  - `POST /internal/chats/:chatId/messages` — `{ senderProfileId, body }` (c2b) → `{ messageId, createdAt }`.
  - `GET /internal/chats/:chatId/messages` — server-visible list (c2b only; c2c returns ciphertext, unused here).
  - Guarded by a new inbound scope **`chat:c2b`** added to Zap's `PERMITTED_INBOUND_SCOPES`.
- **DSAR `account-export`:** c2b message **bodies are included** (server-visible personal data); c2c ciphertext stays excluded. The class makes the rule principled, not special-cased.
- These are reusable by any future c2b consumer (org support chats, e-commerce) — Zap's M3 direction.

**⚠️ Prerequisite:** `zap-api` is **not currently deployed to production**. S4 requires standing it up (a `deploy-zap-api` job + its prod D1 + the cire-api↔zap-api ARC service registration). This is the biggest scope/risk item and lands in the first slice.

## 4. cire side — `vendor_enquiries`

```
vendor_enquiries
  id                  text     enq_<ulid>
  wedding_id          text     → weddings.id (ON DELETE CASCADE)
  directory_vendor_id text     → directory_vendors.id (the listing enquired)
  vendor_id           text     → vendors.id (couple's CRM row; created-if-missing on first enquiry)
  zap_chat_id         text     nullable (provisioned c2b chat id; null until provisioned)
  status              text     enum: 'open' | 'quoted' | 'closed'  (default 'open')
  created_by          text     osn_profile_id (organiser who opened it)
  quoted_minor        integer  nullable (latest quote; mirrors vendors.quoted_minor)
  last_message_at     integer  timestamp (inbox sort)
  created_at, updated_at
  UNIQUE (wedding_id, directory_vendor_id)   -- one thread per (wedding, vendor)
```

- Message bodies live in Zap, not here — cire holds linkage + status + the structured quote.
- `vendor_id` ties the thread to the couple's CRM row (S1) so status/quote surface in the Vendors module.
- **New nullable field on `directory_vendors`:** `lead_forward_email` — the vendor's CRM lead-capture address that cire also emails on a new enquiry.
- LOCKSTEP invariant applies to the cire migration (migration ↔ `setup.ts` DDL ↔ `schema.ts`).

## 5. Flows

**Open** (couple, `weddingEditor`) — `POST /api/organiser/weddings/:weddingId/enquiries { directoryVendorId, message }`:
1. create-if-missing the `vendors` CRM row (reuse S3's add-from-directory snapshot),
2. provision a **c2b chat** (couple `osnProfileId` + the vendor org's member profile) via Zap S2S,
3. append the first message,
4. email the vendor,
5. status `open`. Idempotent on `UNIQUE(wedding_id, directory_vendor_id)` — a repeat enquiry reuses the thread.

**Claimed vs unclaimed vendor (growth loop):**
- **Claimed** (`directory_vendors.owner_org_id` set) → the vendor org member replies in `vendor.`.
- **Unclaimed** → the enquiry email to `directory_vendors.email` carries a **"claim your listing to reply"** CTA; the c2b chat + first message are stored and waiting; the vendor replies **once they claim** (S1 flow). **No inbound-email parsing in v1** — enquiries drive claims.

**Reply** (either side) → cire-api appends to Zap + emails the other party. Reads fetch the thread from Zap on load.

**Quote** (vendor, `vendor.`) — `POST /api/vendor/enquiries/:id/quote { amountMinor, note? }`:
- sets `vendor_enquiries.quoted_minor` **and** the linked `vendors.quoted_minor` (surfaces in the couple's Vendors module),
- posts a quote message, status `quoted`, emails the couple.
- **Informational only — no accept/book** (pre-contractual).

**Quote → Budget** (couple, one-click) — creates a `budget_items` row (name = vendor, category = the CRM row's category, `quoted_minor` = the quote). Feeds S1 Budget.

**Notifications** (`@shared/email`, cire-api sends): vendor "new enquiry" (+ claim CTA if unclaimed, + BCC the optional `lead_forward_email`), couple "new reply" / "you received a quote". New templates.

**Spam control:** per-user `rateLimitMiddlewareByUser` on enquiry-open + message-send, keyed on `osnProfileId`.

## 6. Routes

**Couple side** — `/api/organiser/weddings/:weddingId/enquiries` (osnAuth → role gate → limiter):
- `GET /enquiries` (weddingMember) — the wedding's enquiries + CRM linkage + last-message preview.
- `GET /enquiries/:id/messages` (weddingMember) — thread from Zap.
- `POST /enquiries` (weddingEditor) — open (see Flows).
- `POST /enquiries/:id/messages` (weddingEditor) — reply.

**Vendor side** — `/api/vendor/enquiries` (osnAuth → `vendorOrgMember` gate, same fail-closed ARC pattern as `/api/vendor/*`):
- `GET /enquiries` — enquiries for the vendor's claimed listings.
- `GET /enquiries/:id/messages` — thread.
- `POST /enquiries/:id/messages` — reply.
- `POST /enquiries/:id/quote` — structured quote (see Flows).

Every route re-scopes by wedding (couple side) or vendor org (vendor side) → cross-tenant 404, mirroring S1–S3.

## 7. Compliance

- **DSA Art.30: out of scope** — pre-contractual, no distance contract concluded on-platform. Record in `wiki/compliance/scope-matrix.md`; note that an on-platform "book/accept" slice would trigger it.
- **Enquiry bodies = server-visible personal data** (c2b tradeoff): data-map rows for Zap c2b message bodies + `cire.vendor_enquiries`; retention rows (cire metadata cascades on `weddings.id` delete; Zap c2b bodies included in `account-export`). A **"enquiries aren't end-to-end encrypted"** notice on both thread UIs.
- Notification emails are transactional — no marketing-consent concern. Vendor contact PII already mapped (PR A).

## 8. Frontends

- **`host.` (couple):** an enquiry thread surface inside the Vendors module — "Enquire" from a directory-browse card or a CRM row; thread view (messages, send box, quote card + "Add to budget"); inbox of the wedding's enquiries; empty/unclaimed states; the non-E2E notice.
- **`vendor.` (portal):** an enquiry inbox (list across the org's claimed listings), thread view, reply box, the structured **quote** form; the non-E2E notice.
- No Effect import in either frontend; talk only to cire-api.

## 9. Scope / slicing

Spans two stacks + two frontends → slice like Vendors S1 (A/B):
1. **PR A — Zap c2b infra** (versioned `@zap/*`): `class` column + `messages.body` + generic `/internal/chats` provision + message CRUD + `chat:c2b` scope + DSAR export update + **zap-api prod deployment** (`deploy-zap-api` job + prod D1 + ARC registration). *Meatier than a normal slice because of the deployment.*
2. **PR B — cire-api enquiry backend**: `vendor_enquiries` + migration + `lead_forward_email`, couple + vendor routes, the Zap S2S client, email templates, quote→Budget, limiters, compliance docs. Empty cire changeset; registers the outbound `chat:c2b` scope.
3. **PR C — frontends**: `host.` couple thread + `vendor.` enquiry inbox + quote UI + non-E2E notice.

(Plan phase finalizes whether PR A's deployment is a precursor step or folded in.)

## 10. Testing

- **Backend:** service + route tests — auth/role/limiter; claimed-vs-unclaimed branch; idempotency on `UNIQUE(wedding_id, directory_vendor_id)`; cross-tenant scoping (enquiry scoped to both wedding *and* vendor org → 404 otherwise); quote → `vendors.quoted_minor` → budget line. Zap internal-endpoint tests (c2b provision, server-visible `body`, DSAR includes c2b bodies). cire DDL-lockstep passes.
- **Frontend:** SolidJS island tests — thread render, send, quote card, add-to-budget, empty/unclaimed states, non-E2E notice.
