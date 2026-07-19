# Vendors S4 — PR A (Zap c2b infra) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-visible **c2b** (consumer-to-business) chat class to the Zap messaging stack + the generic ARC-gated internal endpoints cire will call to provision an enquiry thread and read/append server-visible messages — and make zap-api production-deployable.

**Architecture:** Zap gains a `class` axis on chats (`c2c` = E2E personal, `c2b` = server-visible business) and a nullable plaintext `messages.body`. New ARC-gated `/internal/chats` endpoints (scope `chat:c2b`) let a trusted service (cire) provision a c2b chat and CRUD its server-visible messages. DSAR export includes c2b bodies. A `deploy-zap-api` CI job is added, dormant until the prod D1 is provisioned.

**Tech Stack:** zap/api (Elysia on CF Workers, `aot:false`, Effect + ManagedRuntime), zap/db (Drizzle + D1 + drizzle-kit migrations), `@shared/crypto` (ARC), GitHub Actions.

## Global Constraints

- **c2b = server-visible; c2c = E2E.** Encryption/visibility derives from `chats.class`. Invariant: a **c2b** message has `body` set + `ciphertext`/`nonce` NULL; a **c2c** message has `ciphertext`/`nonce` set + `body` NULL.
- **`chats.class` enum exactly:** `'c2c' | 'c2b'`. NOT NULL, DEFAULT `'c2c'` (existing rows + omitting-inserts are personal). Existing `type` enum (`dm`/`group`/`event`) is unchanged (cardinality/origin, orthogonal to class).
- **New inbound ARC scope exactly:** `chat:c2b` — added to `PERMITTED_INBOUND_SCOPES` in `zap/api/src/lib/arc-middleware.ts`. Audience = `zap-api` (the existing `AUDIENCE` constant in `internal.ts`).
- **DSAR:** `/internal/account-export` INCLUDES c2b message `body`, still EXCLUDES c2c `ciphertext`.
- **Effect idiom:** services return `Effect.Effect<A, E, Db>`, tagged errors via `Data.TaggedError`, `Effect.tryPromise({ try, catch })` around Drizzle, `.pipe(Effect.withSpan(...))` where the neighbors do. No thrown exceptions in services.
- **Zap migrations are drizzle-kit-GENERATED** into `zap/db/drizzle/` (NOT hand-written): change `zap/db/src/schema/*` then run `bun run --cwd zap/db db:generate`; commit the generated `.sql` + `meta/` changes. zap-api is NOT yet deployed to prod, so there is **no prod data** — schema rebuilds are safe.
- **`@zap/api` (0.7.1) + `@zap/db` (0.4.2) are VERSIONED** — the PR needs a `@zap/*` changeset (minor bump: new feature). Do NOT mix with `@cire/*`.
- **NO prod actions in this PR.** The plan builds the deploy job + config only. Creating `zap-db-prod` D1, filling the real `database_id`, setting `OSN_JWT_SECRET`, and the **cire-api↔zap-api ARC service registration** are **post-merge, user-authorized deploy-time steps** (documented in the runbook, executed by a human — like cire migration 0042 + the V&R comp were). The `deploy-zap-api` job must be **dormant/skip** while the prod D1 id is still a placeholder.
- **Observability:** no `console.*` in request code; ARC failures already metered by `requireArc`.

---

## File Structure

**Modify (zap/db):**
- `zap/db/src/schema/chats.ts` — add `class` column.
- `zap/db/src/schema/messages.ts` — add nullable `body`; make `ciphertext`/`nonce` nullable.
- `zap/db/drizzle/` — new generated migration (`0001_*.sql` + `meta/`), via `db:generate`.

**Modify (zap/api):**
- `zap/api/src/lib/arc-middleware.ts` — add `chat:c2b` to `PERMITTED_INBOUND_SCOPES`.
- `zap/api/src/lib/limits.ts` — add `MAX_BODY_LENGTH`.
- `zap/api/src/services/chats.ts` — `provisionC2bChat`.
- `zap/api/src/services/messages.ts` — `sendC2bMessage` + `listC2bMessages`.
- `zap/api/src/routes/internal.ts` — 3 new `/internal/chats*` routes (scope `chat:c2b`); update `account-export` to include c2b bodies.
- Tests co-located: `zap/api/src/routes/internal.test.ts` (or the existing internal test file), `zap/api/src/services/*.test.ts`.

**Modify (deploy/infra):**
- `zap/api/wrangler.toml` — add prod `[env.production.vars]` (JWKS/issuer/audience) mirroring cire-api; keep the placeholder D1 id (real id is a deploy-time step).
- `.github/workflows/deploy.yml` — new `deploy-zap-api` job (dormant-until-provisioned).
- `scripts/check-d1-database-id.sh` — extend to cover zap (or the new job self-guards).
- `.changeset/zap-c2b-chats.md` — versioned `@zap/api` + `@zap/db` minor.
- `wiki/runbooks/production-deploy.md` — a "zap-api prod bring-up + cire↔zap ARC registration" section (the authorized deploy-time steps).
- `wiki/apps/zap.md` — document the c2b class + internal endpoints.

---

## Task 1: `chats.class` + server-visible `messages.body` (schema + generated migration)

**Files:**
- Modify: `zap/db/src/schema/chats.ts`, `zap/db/src/schema/messages.ts`
- Generate: `zap/db/drizzle/0001_*.sql` (+ `meta/`)

**Interfaces:**
- Produces: `chats.class` (`'c2c' | 'c2b'`, NOT NULL default `'c2c'`); `messages.body` (text, nullable); `messages.ciphertext`/`messages.nonce` now nullable. Exported `Chat`/`Message` inferred types gain the fields.

- [ ] **Step 1: Add `class` to `chats.ts`**

In `zap/db/src/schema/chats.ts`, add the column after `type` (keep `type` as-is):

```typescript
    type: text("type", { enum: ["dm", "group", "event"] }).notNull(),
    // Relationship class — the encryption/visibility axis, orthogonal to `type`.
    // "c2c" = consumer-to-consumer: personal, E2E (messages carry ciphertext/nonce).
    // "c2b" = consumer-to-business: server-visible (messages carry plaintext `body`),
    // moderatable, and included in DSAR export. Defaults to "c2c" so existing rows
    // and any insert that omits it stay personal.
    class: text("class", { enum: ["c2c", "c2b"] })
      .notNull()
      .default("c2c"),
```

Add an index for c2b lookups in the table's index array:

```typescript
    index("chats_class_idx").on(t.class),
```

- [ ] **Step 2: Add `body` + relax ciphertext/nonce in `messages.ts`**

In `zap/db/src/schema/messages.ts`, change the three columns so c2b can store plaintext and c2c keeps ciphertext:

```typescript
    senderProfileId: text("sender_profile_id").notNull(),
    // c2c (E2E) messages carry ciphertext+nonce; c2b (server-visible) messages
    // carry `body`. Exactly one path is populated per message — enforced in the
    // service layer by chat class. All three are nullable at the DB level.
    ciphertext: text("ciphertext"),
    nonce: text("nonce"),
    body: text("body"),
```

Update the docstring at the top of the file to describe the c2b `body` path alongside the E2E ciphertext path.

- [ ] **Step 3: Generate the migration**

Run: `bun run --cwd zap/db db:generate`
Expected: a new `zap/db/drizzle/0001_<name>.sql` appears (adds `class` with default, adds `body`, rebuilds `messages` to drop NOT NULL on ciphertext/nonce) and `zap/db/drizzle/meta/` is updated. Inspect the `.sql` — confirm it adds `class TEXT NOT NULL DEFAULT 'c2c'`, adds `body`, and makes ciphertext/nonce nullable. There is no prod data, so a table rebuild is safe.

- [ ] **Step 4: Verify zap/db + zap/api still build/typecheck + tests pass**

Run: `bun run --cwd zap/db test:run` and `bun run --cwd zap/api test:run`
Expected: PASS (existing tests unaffected — the new columns are additive/nullable; any `messages` insert in existing tests still supplies ciphertext/nonce). If an existing test asserts an exact `chats` row shape, update it to include `class: "c2c"`.

- [ ] **Step 5: Commit**

```bash
git add zap/db/src/schema/chats.ts zap/db/src/schema/messages.ts zap/db/drizzle
git commit -m "feat(zap): c2b/c2c chat class + server-visible message body (schema + migration)"
```

---

## Task 2: `chat:c2b` scope + `MAX_BODY_LENGTH`

**Files:**
- Modify: `zap/api/src/lib/arc-middleware.ts`, `zap/api/src/lib/limits.ts`
- Test: `zap/api/src/lib/arc-middleware.test.ts` (if present; else assert via the internal-route test in Task 4)

**Interfaces:**
- Produces: `PERMITTED_INBOUND_SCOPES` now includes `"chat:c2b"`; `MAX_BODY_LENGTH` constant.

- [ ] **Step 1: Add the scope**

In `zap/api/src/lib/arc-middleware.ts`, extend the allowlist (keep the existing scopes):

```typescript
/**
 * `account:export`/`account:erase` power the DSAR fan-out; `chat:c2b` lets a
 * trusted service (cire-api) provision consumer-to-business chats and CRUD
 * their server-visible messages via `/internal/chats*`.
 */
export const PERMITTED_INBOUND_SCOPES = new Set(["account:export", "account:erase", "chat:c2b"]);
```

- [ ] **Step 2: Add the body-length limit**

In `zap/api/src/lib/limits.ts`, add (mirror the existing `MAX_CIPHERTEXT_LENGTH` declaration style):

```typescript
/** Max length of a server-visible c2b message body (plaintext chars). */
export const MAX_BODY_LENGTH = 8_000;
```

- [ ] **Step 3: Commit**

```bash
git add zap/api/src/lib/arc-middleware.ts zap/api/src/lib/limits.ts
git commit -m "feat(zap): permit chat:c2b inbound scope + MAX_BODY_LENGTH"
```

---

## Task 3: c2b service functions (`provisionC2bChat`, `sendC2bMessage`, `listC2bMessages`)

**Files:**
- Modify: `zap/api/src/services/chats.ts` (add `provisionC2bChat`)
- Modify: `zap/api/src/services/messages.ts` (add `sendC2bMessage`, `listC2bMessages`)
- Test: `zap/api/src/services/chats.test.ts`, `zap/api/src/services/messages.test.ts`

**Interfaces:**
- Consumes: `chats`, `chatMembers`, `messages` from `@zap/db/schema`; `Db` from `@zap/db/service`; `MAX_BODY_LENGTH`, `MAX_CHAT_MEMBERS`, `MAX_MESSAGE_LIMIT`, `DEFAULT_MESSAGE_LIMIT` from `../lib/limits`; existing tagged errors (`ChatNotFound`, `NotChatMember`, `ValidationError`, `DatabaseError`) + `NotC2bChat` (new).
- Produces:
  - `provisionC2bChat(input: { memberProfileIds: readonly string[]; createdByProfileId: string; title?: string }): Effect.Effect<Chat, ValidationError | DatabaseError, Db>` — inserts a `chats` row with `class: "c2b"`, `type: "group"` (cardinality: 1+ members; not a c2c "dm"), then inserts a `chatMembers` row per member. **Skips the c2c consent gate** (cire is the trusted authorizer for business chats). Enforces `2..MAX_CHAT_MEMBERS` members.
  - `sendC2bMessage(chatId, senderProfileId, data: unknown): Effect.Effect<Message, ChatNotFound | NotChatMember | NotC2bChat | ValidationError | DatabaseError, Db>` — validates `{ body: string (1..MAX_BODY_LENGTH) }`; asserts the chat exists AND `chat.class === "c2b"` (else `NotC2bChat`) AND the sender is a member; inserts a `messages` row with `body` set, `ciphertext`/`nonce` NULL; bumps `chats.updatedAt`.
  - `listC2bMessages(chatId, opts?: { limit?; before? }): Effect.Effect<Message[], ChatNotFound | NotC2bChat | DatabaseError, Db>` — asserts chat is c2b; returns messages (server-visible `body`), newest-first, paginated like the existing `listMessages`.

- [ ] **Step 1: Write failing service tests**

Add to `zap/api/src/services/chats.test.ts` and `messages.test.ts` (follow the existing harness — `Db` test layer over bun:sqlite; run effects via the file's existing runner). Cover:

```typescript
// chats.test.ts
it("provisionC2bChat creates a class='c2b', type='group' chat with all members", async () => {
  const chat = await run(provisionC2bChat({ memberProfileIds: ["usr_a", "usr_b"], createdByProfileId: "usr_a" }));
  expect(chat.class).toBe("c2b");
  expect(chat.type).toBe("group");
  // both members present
});
it("provisionC2bChat rejects <2 members", async () => {
  await expectFailure(provisionC2bChat({ memberProfileIds: ["usr_a"], createdByProfileId: "usr_a" }));
});

// messages.test.ts
it("sendC2bMessage stores plaintext body, null ciphertext/nonce", async () => {
  const chat = await run(provisionC2bChat({ memberProfileIds: ["usr_a", "usr_b"], createdByProfileId: "usr_a" }));
  const msg = await run(sendC2bMessage(chat.id, "usr_a", { body: "hello" }));
  expect(msg.body).toBe("hello");
  expect(msg.ciphertext).toBeNull();
  expect(msg.nonce).toBeNull();
});
it("sendC2bMessage fails NotC2bChat on a c2c chat", async () => {
  // create a normal dm/c2c chat via the existing createChat, then sendC2bMessage → NotC2bChat
});
it("sendC2bMessage fails NotChatMember for a non-member sender", async () => { /* ... */ });
it("listC2bMessages returns bodies newest-first", async () => { /* ... */ });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --cwd zap/api test:run -- chats messages`
Expected: FAIL — functions/`NotC2bChat` not defined.

- [ ] **Step 3: Implement**

In `chats.ts`, add the `NotC2bChat` tagged error (or place it in `messages.ts` and export; keep one definition) and `provisionC2bChat`, mirroring the existing `createChat`'s insert-chat-then-insert-members flow but with `class: "c2b"`, `type: "group"`, no consent call, and a `2..MAX_CHAT_MEMBERS` guard. In `messages.ts`, add `sendC2bMessage` (mirror `sendMessage` but validate `{ body }` via a `SendC2bMessageSchema = Schema.Struct({ body: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_BODY_LENGTH)) })`, assert `chat.class === "c2b"`, insert `body`) and `listC2bMessages` (mirror the existing `listMessages` but assert c2b and select `body`). Reuse the existing `assertMember` helper for the membership check.

- [ ] **Step 4: Run — expect PASS**

Run: `bun run --cwd zap/api test:run -- chats messages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add zap/api/src/services/chats.ts zap/api/src/services/messages.ts zap/api/src/services/chats.test.ts zap/api/src/services/messages.test.ts
git commit -m "feat(zap): c2b provisioning + server-visible message service fns"
```

---

## Task 4: Internal `/internal/chats*` endpoints (ARC `chat:c2b`)

**Files:**
- Modify: `zap/api/src/routes/internal.ts`
- Test: `zap/api/src/routes/internal.test.ts` (co-located; follow its harness for ARC tokens — likely `registerServiceKey` + a signed token via `@shared/crypto` test helpers, mirroring the existing account-export test)

**Interfaces:**
- Consumes: `requireArc`, `AUDIENCE` (`"zap-api"`), the Task-3 service fns, `runtime.runPromise`.
- Produces (all require `Authorization: ARC <token>` with scope `chat:c2b`, audience `zap-api`):
  - `POST /internal/chats` — body `{ memberProfileIds: string[]; createdByProfileId: string; title?: string }` → `201 { chatId }`.
  - `POST /internal/chats/:chatId/messages` — body `{ senderProfileId: string; body: string }` → `201 { messageId, createdAt }`.
  - `GET /internal/chats/:chatId/messages?limit&before` → `200 { messages: [{ id, senderProfileId, body, createdAt }] }`.
  - Errors map to HTTP: `ValidationError`→400, `ChatNotFound`→404, `NotC2bChat`→409, `NotChatMember`→403, `DatabaseError`→500.

- [ ] **Step 1: Write failing route tests**

In `internal.test.ts`, mirror the existing account-export ARC test setup (register a service key, mint an ARC token with scope `chat:c2b`, audience `zap-api`). Assert:
- no/invalid ARC token → 401 on all three;
- a token scoped `account:export` (not `chat:c2b`) → 401 (scope enforced);
- `POST /internal/chats` with 2 members → 201 + a `chatId`;
- `POST /internal/chats/:id/messages` → 201, then `GET` returns the body;
- posting to a c2c chat id → 409.

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --cwd zap/api test:run -- internal`
Expected: FAIL — routes not defined.

- [ ] **Step 3: Implement the routes**

In `createInternalRoutes` (`internal.ts`), add the three routes after the existing `account-export` route, each guarded by `const caller = await requireArc(headers.authorization, set, AUDIENCE, "chat:c2b"); if (!caller) return { error: "Unauthorized" };`, then unwrap the Task-3 service via `runtime.runPromise` with a `try/catch`-style `.pipe` that maps the tagged errors to the statuses above. Use Elysia `t.Object` body schemas mirroring the existing `register-service` route's `body` validation. `POST` routes set `set.status = 201`.

- [ ] **Step 4: Run — expect PASS**

Run: `bun run --cwd zap/api test:run -- internal`
Expected: PASS. Then the full suite: `bun run --cwd zap/api test:run` (green).

- [ ] **Step 5: Commit**

```bash
git add zap/api/src/routes/internal.ts zap/api/src/routes/internal.test.ts
git commit -m "feat(zap): ARC-gated /internal/chats provision + message CRUD (chat:c2b)"
```

---

## Task 5: DSAR export includes c2b bodies

**Files:**
- Modify: `zap/api/src/routes/internal.ts` (the `account-export` handler + `loadChatMemberships`)
- Test: `zap/api/src/routes/internal.test.ts`

**Interfaces:**
- The export gains, per c2b chat the profile is a member of, its message `body` lines; c2c ciphertext stays excluded.

- [ ] **Step 1: Write the failing test**

Add to `internal.test.ts`: seed a c2b chat with two members + two `body` messages and a c2c chat with a ciphertext message; call `/internal/account-export` (ARC `account:export`) for one member; assert the NDJSON contains the c2b bodies (a new section, e.g. `"section":"zap.c2b_messages"`) and does NOT contain the c2c ciphertext.

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --cwd zap/api test:run -- internal`
Expected: FAIL — export currently returns only `zap.chats` membership metadata.

- [ ] **Step 3: Implement**

Extend the export to also read c2b message bodies authored in / visible to the profile's c2b chats and emit `{"section":"zap.c2b_messages","record":{ chatId, body, createdAt }}` lines. Keep the existing `zap.chats` membership section. Do NOT read `messages.ciphertext` anywhere (the existing comment's guarantee holds for c2c). Scope the read to chats where the profile is a member AND `chats.class = 'c2b'`.

- [ ] **Step 4: Run — expect PASS**

Run: `bun run --cwd zap/api test:run -- internal` then full `bun run --cwd zap/api test:run`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add zap/api/src/routes/internal.ts zap/api/src/routes/internal.test.ts
git commit -m "feat(zap): include c2b message bodies in DSAR account-export"
```

---

## Task 6: zap-api Workers deploy config + dormant `deploy-zap-api` CI job

**Files:**
- Modify: `zap/api/wrangler.toml` (add prod vars; keep placeholder D1 id)
- Modify: `.github/workflows/deploy.yml` (new `deploy-zap-api` job)
- Modify: `scripts/check-d1-database-id.sh` (cover zap, non-fatally) OR self-guard in the job
- Create: runbook section

**Interfaces:**
- Produces: a CI job that, once the prod D1 exists and its id is filled in, migrates `zap-db-prod` (`--env production`) then `wrangler deploy --env production`; while the id is a placeholder, the job **skips with success** (no red CI, no deploy against a non-existent DB).

- [ ] **Step 1: Add prod vars to `zap/api/wrangler.toml`**

Mirror cire-api's prod var set (JWKS/issuer/audience the Worker needs to verify OSN user tokens). Add under production (keep the placeholder `database_id` — filling it is a deploy-time step):

```toml
[env.production.vars]
OSN_JWKS_URL = "https://id.cireweddings.com/.well-known/jwks.json"
OSN_ISSUER_URL = "https://id.cireweddings.com"
OSN_AUDIENCE = "osn-access"
```

(Confirm the exact var names zap-api reads from `env` in `src/index.ts` / `jwks.ts` and match them; add only the ones it actually reads.)

- [ ] **Step 2: Add the dormant `deploy-zap-api` job to `deploy.yml`**

Mirror `deploy-cire-api` (lines 77–124) exactly, with `working-directory: zap/api`, migrating `zap-db-prod --env production`, and a **leading guard step that skips the job when the D1 id is still a placeholder**:

```yaml
  deploy-zap-api:
    name: Deploy zap/api (+ D1 migrate)
    needs: build
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version
      - name: Cache bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
          restore-keys: |
            ${{ runner.os }}-bun-
      - name: Install dependencies
        run: bun install
      # zap-api is not provisioned in prod until its D1 exists + its id is filled
      # into wrangler.toml (a deploy-time step). Until then, SKIP (green) so this
      # job never deploys against a non-existent DB and never reds the pipeline.
      - name: Detect zap prod provisioning
        id: zapcheck
        run: |
          if grep -q 'placeholder-replace-after-d1-create' zap/api/wrangler.toml; then
            echo "provisioned=false" >> "$GITHUB_OUTPUT"
            echo "zap-api prod D1 not provisioned yet — skipping deploy."
          else
            echo "provisioned=true" >> "$GITHUB_OUTPUT"
          fi
      - name: Apply zap D1 migrations (remote prod)
        if: steps.zapcheck.outputs.provisioned == 'true'
        run: bunx wrangler d1 migrations apply zap-db-prod --env production --remote
        working-directory: zap/api
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Deploy zap/api Worker
        if: steps.zapcheck.outputs.provisioned == 'true'
        run: bunx wrangler deploy --env production
        working-directory: zap/api
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 3: Keep `check-d1-database-id.sh` from failing on zap's placeholder**

Read `scripts/check-d1-database-id.sh`. If it scans all `*/wrangler.toml` (would now fail on zap's intentional placeholder), scope it to cire-api (or make zap a known-pending exception) so the `deploy-cire-api` guard stays green. If it only scans cire-api, no change needed — note that in the report.

- [ ] **Step 4: Verify the workflow parses + the guard logic is sound**

Run: `bunx --bun @action-validator/cli .github/workflows/deploy.yml` if available; otherwise `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml'))"` to confirm valid YAML. Manually confirm the skip-branch: with the placeholder present, `provisioned=false` and both deploy steps are skipped.

- [ ] **Step 5: Commit**

```bash
git add zap/api/wrangler.toml .github/workflows/deploy.yml scripts/check-d1-database-id.sh
git commit -m "ci(zap): dormant deploy-zap-api job + prod vars (skips until D1 provisioned)"
```

---

## Task 7: Docs + versioned changeset

**Files:**
- Modify: `wiki/apps/zap.md` (c2b class + internal endpoints), `wiki/runbooks/production-deploy.md` (zap bring-up)
- Create: `.changeset/zap-c2b-chats.md`

- [ ] **Step 1: Document the c2b model in `wiki/apps/zap.md`**

Add a "c2b (consumer-to-business) chats" section: the `class` axis, server-visible `body` vs c2c ciphertext, the `/internal/chats*` endpoints + `chat:c2b` scope, and that DSAR includes c2b bodies. Update `last-reviewed: 2026-07-19`.

- [ ] **Step 2: Document the deploy-time bring-up (the authorized human steps)**

Add a `production-deploy.md` section "zap-api production bring-up (PR A follow-up)": (a) `wrangler d1 create zap-db-prod` → copy the id into `zap/api/wrangler.toml` `[env.production]`; (b) `wrangler secret put OSN_JWT_SECRET --env production` (+ any other secrets zap reads); (c) first deploy runs automatically once the id is filled (the dormant job activates); (d) **cire-api↔zap-api ARC registration**: cire-api registers its ARC public key with zap-api's `POST /internal/register-service` using `INTERNAL_SERVICE_SECRET`, requesting `allowedScopes: "chat:c2b"` (mirror the cire↔osn `org:read` registration in this same runbook). Mark the whole section **"requires explicit authorization; prod writes."**

- [ ] **Step 3: Versioned changeset**

Create `.changeset/zap-c2b-chats.md`:

```markdown
---
"@zap/api": minor
"@zap/db": minor
---

Add a server-visible c2b (consumer-to-business) chat class to Zap: `chats.class`, plaintext `messages.body`, ARC-gated `/internal/chats` provisioning + message CRUD (scope `chat:c2b`), and c2b bodies in the DSAR export. Adds a dormant `deploy-zap-api` CI job (activates once the prod D1 is provisioned).
```

- [ ] **Step 4: Validate + full check**

Run: `bash scripts/validate-changesets.sh` (expect pass — `@zap/*` are versioned), `bun run --cwd zap/api test:run`, `bun run --cwd zap/db test:run`, `bun run lint`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add wiki/apps/zap.md wiki/runbooks/production-deploy.md .changeset/zap-c2b-chats.md
git commit -m "docs(zap): c2b chats + zap-api prod bring-up runbook + changeset"
```

---

## Notes for the executor

- **After all tasks:** run `/prep-pr` (parallel perf + security/EAA/compliance reviews + structured PR body). Security emphasis: the `/internal/chats*` routes are a NEW ARC-authed write surface — confirm scope enforcement (`chat:c2b` only), that a c2b chat can't be posted to by a non-member, and that c2c ciphertext is never exposed by the new endpoints or the DSAR change. Then `superpowers:finishing-a-development-branch` → push + open PR. **Do NOT merge**, and **do NOT** run any prod step (D1 create, secret put, ARC registration) — those are the user-authorized deploy-time steps in the runbook.
- This is **PR A of 3** (spec §9). PR B = cire-api enquiry backend (consumes these endpoints); PR C = frontends. Do not build those here.
