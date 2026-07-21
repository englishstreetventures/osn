# cire Vendors S4 — PR C (Enquiry Frontends) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the couple-side and vendor-side enquiry UIs against the already-live PR B backend — a couple contacts a directory vendor, holds a thread, adds a quote to Budget; a vendor reads an inbox, replies, and sends a structured quote.

**Architecture:** Two Astro + SolidJS islands (`cire/organiser` = couple/host, `cire/vendor` = vendor portal) that talk **only** to cire-api via `authFetch`. Couple enquiries live as a third sub-tab inside the existing **Vendors** module; the vendor portal gets an account-level **Enquiries** surface toggled from the top bar. One small backend addition returns the enquiring wedding's name to the vendor inbox. No Effect, no WebSocket, no E2E — reads are on-load + refetch-after-send.

**Tech Stack:** SolidJS (`createSignal`/`createResource`/`createMemo`/`createEffect`, `<Show>`/`<For>`), `@osn/client/solid` `useAuth().authFetch`, `solid-toast`, Tailwind v4 semantic tokens, Vitest + happy-dom + `@solidjs/testing-library`; backend task in cire/api (Elysia + Effect + Drizzle).

## Global Constraints

- **No `effect` import** in `cire/organiser` or `cire/vendor` — Effect is backend-only (cire CLAUDE.md). Frontends are plain TS.
- **Every network call goes through `authFetch`** from `useAuth()` (`@osn/client/solid`). Base URL via `apiUrl(path)` from the app's `src/lib/api.ts`. On `res.status === 401` call `redirectToLogin()` and stop; on `isAuthExpired(err)` in a catch, `redirectToLogin()`.
- **Money is integer minor units.** Display with `new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100)`. Wedding currency is passed down (default `"AUD"`).
- **Non-E2E notice (exact copy, both thread UIs):** `Enquiries aren't end-to-end encrypted. cire can read these messages to keep the marketplace safe — please don't share passwords or card details.`
- **Styling:** Tailwind semantic tokens only — `bg-bg`/`bg-surface`/`bg-surface-raised`, `text-text`/`text-text-muted`, `text-gold`/`text-gold-dim`/`bg-gold`/`border-gold`, `border-border`, `text-error`/`bg-error/5`/`border-error/40`, `text-success`. Fonts `font-body` (Lato) / `font-display` (Cormorant). `rounded-sm`. Labels are `text-[0.68rem] tracking-[0.16em] uppercase` (organiser) / `text-[0.72rem] tracking-[0.1em] uppercase` (vendor). Match the neighbouring component's classes exactly.
- **Category labels:** `categoryLabel(key)` from the app's own `src/lib/service-categories.ts` (both apps have one).
- **Error-code → friendly copy** for enquiry writes: `awaiting_vendor` → "This vendor hasn't joined yet — they'll get your first message when they claim their listing."; `vendor_chat_unavailable` → "Messaging is temporarily unavailable. Please try again shortly."; `read_only_role` (403) → "You have view-only access to this wedding."; else generic.
- **Tests:** SolidJS component tests start with `// @vitest-environment happy-dom`, use `@solidjs/testing-library` (`render`/`screen`/`fireEvent`/`waitFor`/`cleanup`), mock auth with `vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }))` (organiser) or the fuller mock (vendor — see Task 8). Store/api-helper tests mock `authFetch` as `vi.fn().mockResolvedValue(new Response(JSON.stringify(...), { status }))`.
- **Changeset:** ONE version-less `@cire/*` changeset covering `@cire/api`, `@cire/organiser`, `@cire/vendor` (Task 11). Never mix with versioned packages.
- **Commit** after each task's tests pass. Branch is `feat/cire-enquiries-frontends` (already checked out at the worktree root).

### Backend API contract (already live — do not change except Task 1)

Couple, prefix `/api/organiser/weddings/:weddingId` (reads = any host; writes = editor, viewer→403 `read_only_role`):
- `GET /enquiries` → `200 { enquiries: EnquiryListItem[] }`
- `GET /enquiries/:id/messages` → `200 { messages: MessageDto[] }` | `404 {error:"enquiry_not_found"}` | `503 {error:"vendor_chat_unavailable"}`
- `POST /enquiries` body `{ directoryVendorId, category, message }` → `201 { enquiry: EnquiryDto }` | `400` | `409 {error:"awaiting_vendor"}` | `503`
- `POST /enquiries/:id/messages` body `{ message }` → `201 { message: MessageDto }` | `400` | `409 awaiting_vendor` | `503`
- `POST /enquiries/:id/add-to-budget` → `201 { budgetItemId: string }` | `404` | `503`

Vendor, prefix `/api/vendor` (account-wide; scoped to caller's orgs server-side):
- `GET /enquiries` → `200 { enquiries: VendorEnquiryListItem[] }` (newest-first)
- `GET /enquiries/:id/messages` → `200 { messages: MessageDto[] }` | `404` | `503`
- `POST /enquiries/:id/messages` body `{ message }` → `201 { message: MessageDto }` | `400` | `404` | `409` | `503`
- `POST /enquiries/:id/quote` body `{ amountMinor: int>0, note? }` → `201 { enquiry: VendorEnquiryDto }` | `400` | `404` | `409` | `503`

**DTO shapes (TS):**
```ts
interface EnquiryDto {
  id: string; weddingId: string; directoryVendorId: string; vendorId: string;
  zapChatId: string | null; status: "open" | "quoted" | "closed";
  createdBy: string; quotedMinor: number | null;
  lastMessageAt: number; createdAt: number; updatedAt: number; // epoch ms
}
interface EnquiryListItem extends EnquiryDto { vendorName: string; category: string } // couple side
interface MessageDto { id: string; senderProfileId: string; body: string; createdAt: number }
// vendor side list item = EnquiryDto-shaped + vendorName + category + (Task 1) weddingName
```

---

## Task 1: Backend — surface the enquiring wedding's name on the vendor inbox

**Files:**
- Modify: `cire/api/src/routes/vendor-enquiries.ts` (the `GET /enquiries` inline query ~lines 177–207, and `toVendorDto` ~line 328)
- Test: `cire/api/src/routes/vendor-enquiries.test.ts` (the `GET /api/vendor/enquiries` describe, ~line 268)

**Interfaces:**
- Produces: vendor `GET /enquiries` items now include `weddingName: string` (the enquiring wedding's `weddings.display_name`). Consumed by Task 8's `VendorEnquiryListItem` type and Task 9's inbox rows.

- [ ] **Step 1: Write the failing test.** In `vendor-enquiries.test.ts`, extend the existing "lists only enquiries on the caller's own org's listings" test (~line 275) to also assert the wedding name is present. The seed already creates the couple's wedding via `seedDb`/helpers with a `display_name`; find the couple wedding's display name in the seed (search the file for the wedding row that owns `mine.enquiryId` — it is seeded near `COUPLE`/`BOOTSTRAP_WEDDING_ID`). Add after the existing `expect(body.enquiries[0]!.id)...` assertions:

```ts
const item = body.enquiries[0] as { id: string; directoryVendorId: string; weddingName: string };
expect(typeof item.weddingName).toBe("string");
expect(item.weddingName.length).toBeGreaterThan(0);
```

Also widen the test's response type annotation to include `weddingName: string`.

- [ ] **Step 2: Run it, verify it fails.** Run: `bun run --cwd cire/api test -- vendor-enquiries` (or the package's test runner for that file). Expected: FAIL — `weddingName` is `undefined`.

- [ ] **Step 3: Implement.** In `vendor-enquiries.ts` `GET /enquiries` handler, add a join to `weddings` and select its display name. The query currently joins `directoryVendors` and `vendors`; add:

```ts
// import weddings from "@cire/db" at top (add to the existing @cire/db import)
.select({
  enquiry: vendorEnquiries,
  vendorName: vendors.name,
  category: vendors.category,
  weddingName: weddings.displayName,
})
// ...existing .from(vendorEnquiries).innerJoin(directoryVendors, ...).innerJoin(vendors, ...)
.innerJoin(weddings, eq(vendorEnquiries.weddingId, weddings.id))
.where(inArray(directoryVendors.ownerOrgId, callerOrgIds))
```

Widen the `rows as Array<{...}>` cast to include `weddingName: string`, and in the `.map`, spread it onto the returned item:

```ts
const enquiries = all
  .map((r) => ({ ...toVendorDto(r.enquiry), vendorName: r.vendorName, category: r.category, weddingName: r.weddingName }))
  .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
```

`weddings` and `eq`/`inArray` are already imported (verify; add `weddings` to the `@cire/db` import if absent). Do NOT change `toVendorDto` itself — `weddingName` is joined, not part of the enquiry row.

- [ ] **Step 4: Run tests, verify pass.** Run the vendor-enquiries route tests. Expected: PASS. Also run the full cire/api suite once to confirm no regression: `bun run --cwd cire/api test`.

- [ ] **Step 5: Commit.** `git add cire/api/src/routes/vendor-enquiries.ts cire/api/src/routes/vendor-enquiries.test.ts && git commit -m "feat(cire/api): return enquiring wedding name on vendor enquiry inbox"`

---

## Task 2: Organiser — enquiries store (per-wedding inbox cache)

**Files:**
- Create: `cire/organiser/src/lib/enquiries-store.ts`
- Test: `cire/organiser/src/lib/enquiries-store.test.ts`

**Interfaces:**
- Produces: `EnquiryListItem`, `EnquiryMessage` types; `enquiriesAccessor(weddingId): Accessor<EnquiryListItem[] | null>`, `setCachedEnquiries(weddingId, items)`, `peekCachedEnquiries(weddingId)`, `invalidateEnquiries(weddingId)`, `ensureEnquiriesLoaded(weddingId, fetcher)`, `upsertCachedEnquiry(weddingId, item)`, `__resetEnquiriesCache()`. Consumed by Tasks 3, 6, 7.

Mirror `cire/organiser/src/lib/vendors-store.ts` exactly (same singleton-map + `createSignal` + `ensureLoaded` dedup + `__reset` pattern — read it first).

- [ ] **Step 1: Write the failing test.** `enquiries-store.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetEnquiriesCache, enquiriesAccessor, ensureEnquiriesLoaded,
  peekCachedEnquiries, setCachedEnquiries, invalidateEnquiries, upsertCachedEnquiry,
  type EnquiryListItem,
} from "./enquiries-store";

const item = (over: Partial<EnquiryListItem> = {}): EnquiryListItem => ({
  id: "enq_1", weddingId: "wed_1", directoryVendorId: "dv_1", vendorId: "v_1",
  zapChatId: null, status: "open", createdBy: "p_1", quotedMinor: null,
  lastMessageAt: 1, createdAt: 1, updatedAt: 1, vendorName: "Blue Roses", category: "florals",
  ...over,
});

beforeEach(() => __resetEnquiriesCache());

describe("enquiries-store", () => {
  it("caches and reads back per wedding", () => {
    setCachedEnquiries("wed_1", [item()]);
    expect(peekCachedEnquiries("wed_1")).toHaveLength(1);
    expect(enquiriesAccessor("wed_1")()![0]!.vendorName).toBe("Blue Roses");
  });

  it("ensureEnquiriesLoaded fetches once and dedups concurrent calls", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return [item()]; };
    await Promise.all([ensureEnquiriesLoaded("wed_1", fetcher), ensureEnquiriesLoaded("wed_1", fetcher)]);
    expect(calls).toBe(1);
    expect(peekCachedEnquiries("wed_1")).toHaveLength(1);
  });

  it("upsertCachedEnquiry replaces by id and prepends new ones", () => {
    setCachedEnquiries("wed_1", [item({ id: "enq_1", status: "open" })]);
    upsertCachedEnquiry("wed_1", item({ id: "enq_1", status: "quoted", quotedMinor: 5000 }));
    upsertCachedEnquiry("wed_1", item({ id: "enq_2" }));
    const rows = peekCachedEnquiries("wed_1")!;
    expect(rows.find((r) => r.id === "enq_1")!.status).toBe("quoted");
    expect(rows.map((r) => r.id)).toContain("enq_2");
  });

  it("invalidateEnquiries clears the cache so a reload refetches", async () => {
    setCachedEnquiries("wed_1", [item()]);
    invalidateEnquiries("wed_1");
    let calls = 0;
    await ensureEnquiriesLoaded("wed_1", async () => { calls++; return []; });
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify it fails** (module not found). Run: `bun run --cwd cire/organiser test -- enquiries-store`.

- [ ] **Step 3: Implement `enquiries-store.ts`.** Copy the structure of `vendors-store.ts`. Types:

```ts
import { type Accessor, createSignal, type Setter } from "solid-js";

export interface EnquiryListItem {
  id: string; weddingId: string; directoryVendorId: string; vendorId: string;
  zapChatId: string | null; status: "open" | "quoted" | "closed";
  createdBy: string; quotedMinor: number | null;
  lastMessageAt: number; createdAt: number; updatedAt: number;
  vendorName: string; category: string;
}
export interface EnquiryMessage { id: string; senderProfileId: string; body: string; createdAt: number }
```

Implement the singleton `Map<string, { enquiries, setEnquiries }>` with `entryFor`, `hasCachedEnquiries`, the exported accessor/set/peek/invalidate, the `inflight` dedup map for `ensureEnquiriesLoaded`, and:

```ts
export function upsertCachedEnquiry(weddingId: string, next: EnquiryListItem): void {
  const cur = peekCachedEnquiries(weddingId) ?? [];
  const without = cur.filter((e) => e.id !== next.id);
  setCachedEnquiries(weddingId, [next, ...without].sort((a, b) => b.lastMessageAt - a.lastMessageAt));
}
export function __resetEnquiriesCache(): void { cache.clear(); inflight.clear(); }
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit.** `git add cire/organiser/src/lib/enquiries-store.* && git commit -m "feat(cire/organiser): enquiries inbox store"`

---

## Task 3: Organiser — enquiries API helper module

**Files:**
- Create: `cire/organiser/src/lib/enquiries-api.ts`
- Test: `cire/organiser/src/lib/enquiries-api.test.ts`

**Interfaces:**
- Consumes: `EnquiryListItem`, `EnquiryMessage` (Task 2); `apiUrl` from `./api`.
- Produces: `type AuthFetch = typeof fetch`-compatible; `fetchEnquiries(authFetch, weddingId): Promise<EnquiryListItem[]>`; `fetchMessages(authFetch, weddingId, enquiryId): Promise<EnquiryMessage[]>`; `openEnquiry(authFetch, weddingId, input: { directoryVendorId; category; message }): Promise<EnquiryListItem>`; `replyEnquiry(authFetch, weddingId, enquiryId, message): Promise<EnquiryMessage>`; `addEnquiryToBudget(authFetch, weddingId, enquiryId): Promise<{ budgetItemId: string }>`; `enquiryErrorMessage(err): string`. Also `class EnquiryApiError extends Error { code: string; status: number }`. Consumed by Tasks 6, 7.

The `openEnquiry` response is `{ enquiry: EnquiryDto }` (no vendorName/category); the caller (Task 7) supplies vendorName+category it already has, so `openEnquiry` returns an `EnquiryListItem` by merging the passed `vendorName`/`category`. Adjust its signature: `openEnquiry(authFetch, weddingId, input: { directoryVendorId; category; message; vendorName: string }): Promise<EnquiryListItem>`.

- [ ] **Step 1: Write the failing test.** `enquiries-api.test.ts` — mock `authFetch` as `vi.fn()`. Cover:
  - `fetchEnquiries` GETs `/api/organiser/weddings/wed_1/enquiries` and returns `body.enquiries`.
  - `openEnquiry` POSTs `{directoryVendorId,category,message}` to `/enquiries`, and returns an item whose `vendorName`/`category` come from the input and whose other fields come from `body.enquiry`.
  - `replyEnquiry` POSTs `{message}` to `/enquiries/:id/messages`, returns `body.message`.
  - `addEnquiryToBudget` POSTs to `/enquiries/:id/add-to-budget`, returns `body`.
  - On a `409 {error:"awaiting_vendor"}` response, the reply/open promise rejects with an `EnquiryApiError` whose `.code === "awaiting_vendor"`, and `enquiryErrorMessage(err)` returns the friendly awaiting-vendor copy.
  - On `503 {error:"vendor_chat_unavailable"}`, `.code === "vendor_chat_unavailable"` and friendly copy matches.

Example assertion block:
```ts
const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
it("openEnquiry merges vendorName/category and posts the body", async () => {
  const authFetch = vi.fn().mockResolvedValue(jsonRes({ enquiry: {
    id: "enq_9", weddingId: "wed_1", directoryVendorId: "dv_1", vendorId: "v_1",
    zapChatId: null, status: "open", createdBy: "p", quotedMinor: null,
    lastMessageAt: 5, createdAt: 5, updatedAt: 5,
  } }, 201));
  const item = await openEnquiry(authFetch, "wed_1", { directoryVendorId: "dv_1", category: "florals", message: "hi", vendorName: "Blue Roses" });
  expect(item.vendorName).toBe("Blue Roses");
  expect(item.category).toBe("florals");
  expect(item.id).toBe("enq_9");
  const [url, init] = authFetch.mock.calls[0]!;
  expect(String(url)).toMatch(/\/weddings\/wed_1\/enquiries$/);
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ directoryVendorId: "dv_1", category: "florals", message: "hi" });
});
it("maps 409 awaiting_vendor to a typed error + friendly copy", async () => {
  const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "awaiting_vendor" }, 409));
  await expect(replyEnquiry(authFetch, "wed_1", "enq_9", "hi")).rejects.toMatchObject({ code: "awaiting_vendor" });
});
```

- [ ] **Step 2: Run, verify it fails.** `bun run --cwd cire/organiser test -- enquiries-api`.

- [ ] **Step 3: Implement `enquiries-api.ts`.** Pattern:

```ts
import { apiUrl } from "./api";
import type { EnquiryListItem, EnquiryMessage } from "./enquiries-store";

type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;
const base = (weddingId: string) => `/api/organiser/weddings/${encodeURIComponent(weddingId)}/enquiries`;

export class EnquiryApiError extends Error {
  constructor(public code: string, public status: number) { super(code); this.name = "EnquiryApiError"; }
}
async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new EnquiryApiError(body?.error ?? `http_${res.status}`, res.status);
}
export async function fetchEnquiries(authFetch: AuthFetch, weddingId: string): Promise<EnquiryListItem[]> {
  const res = await authFetch(apiUrl(base(weddingId)));
  await ensureOk(res);
  const body = (await res.json()) as { enquiries: EnquiryListItem[] };
  return body.enquiries ?? [];
}
// fetchMessages, replyEnquiry, addEnquiryToBudget follow the same ensureOk pattern.
export async function openEnquiry(authFetch: AuthFetch, weddingId: string,
  input: { directoryVendorId: string; category: string; message: string; vendorName: string }): Promise<EnquiryListItem> {
  const res = await authFetch(apiUrl(base(weddingId)), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directoryVendorId: input.directoryVendorId, category: input.category, message: input.message }),
  });
  await ensureOk(res);
  const body = (await res.json()) as { enquiry: Omit<EnquiryListItem, "vendorName" | "category"> };
  return { ...body.enquiry, vendorName: input.vendorName, category: input.category };
}
export function enquiryErrorMessage(err: unknown): string {
  const code = err instanceof EnquiryApiError ? err.code : "";
  if (code === "awaiting_vendor") return "This vendor hasn't joined yet — they'll get your first message when they claim their listing.";
  if (code === "vendor_chat_unavailable") return "Messaging is temporarily unavailable. Please try again shortly.";
  if (code === "read_only_role") return "You have view-only access to this wedding.";
  return "Something went wrong. Please try again.";
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit.** `git add cire/organiser/src/lib/enquiries-api.* && git commit -m "feat(cire/organiser): enquiries API helpers"`

---

## Task 4: Organiser — enquiry inbox list (presentational)

**Files:**
- Create: `cire/organiser/src/components/EnquiryInbox.tsx`
- Test: `cire/organiser/src/components/EnquiryInbox.test.tsx`

**Interfaces:**
- Consumes: `EnquiryListItem` (Task 2), `categoryLabel` from `../lib/service-categories`.
- Produces: `default function EnquiryInbox(props: { items: EnquiryListItem[]; currency: string; onOpen: (id: string) => void })`. Consumed by Task 6.

Presentational only — no fetching. Renders an empty-state when `items` is empty, else a `<For>` list of buttons (each calls `props.onOpen(item.id)`), showing `vendorName`, `categoryLabel(category)`, a status chip (`open`/`quoted`/`closed`), the quote (if `quotedMinor != null`) formatted in `currency`, and a relative/short date from `lastMessageAt`. Match VendorsView's row classes (`border-border bg-surface/10 ... rounded-sm border`).

- [ ] **Step 1: Write the failing test.**
```ts
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import EnquiryInbox from "./EnquiryInbox";
import type { EnquiryListItem } from "../lib/enquiries-store";

const item = (o: Partial<EnquiryListItem> = {}): EnquiryListItem => ({
  id: "enq_1", weddingId: "w", directoryVendorId: "dv", vendorId: "v", zapChatId: "c",
  status: "quoted", createdBy: "p", quotedMinor: 250000, lastMessageAt: 1, createdAt: 1, updatedAt: 1,
  vendorName: "Blue Roses", category: "florals", ...o,
});
afterEach(cleanup);

describe("EnquiryInbox", () => {
  it("shows an empty state when there are no enquiries", () => {
    render(() => <EnquiryInbox items={[]} currency="AUD" onOpen={() => {}} />);
    expect(screen.getByText(/no enquiries yet/i)).toBeInTheDocument();
  });
  it("renders a row and fires onOpen", () => {
    const onOpen = vi.fn();
    render(() => <EnquiryInbox items={[item()]} currency="AUD" onOpen={onOpen} />);
    expect(screen.getByText("Blue Roses")).toBeInTheDocument();
    expect(screen.getByText("Florals")).toBeInTheDocument();
    expect(screen.getByText(/\$2,500\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Blue Roses"));
    expect(onOpen).toHaveBeenCalledWith("enq_1");
  });
});
```
- [ ] **Step 2: Run, verify it fails.** `bun run --cwd cire/organiser test -- EnquiryInbox`.
- [ ] **Step 3: Implement `EnquiryInbox.tsx`** as described (a `formatMinor(minor, currency)` local helper; a `statusChip` map; `<For>` over `props.items`; each row a `<button type="button" onClick={() => props.onOpen(item.id)}>`; empty-state copy contains "No enquiries yet"). No `authFetch`, no store import beyond the type.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit.** `git add cire/organiser/src/components/EnquiryInbox.* && git commit -m "feat(cire/organiser): enquiry inbox list component"`

---

## Task 5: Organiser — enquiry thread (presentational: messages, send, quote card, add-to-budget)

**Files:**
- Create: `cire/organiser/src/components/EnquiryThread.tsx`
- Test: `cire/organiser/src/components/EnquiryThread.test.tsx`

**Interfaces:**
- Consumes: `EnquiryListItem`, `EnquiryMessage` (Task 2).
- Produces: `default function EnquiryThread(props: { enquiry: EnquiryListItem; messages: EnquiryMessage[]; loading: boolean; error: string | null; ownProfileId: string; currency: string; canEdit: boolean; onBack: () => void; onSend: (message: string) => Promise<void>; onAddToBudget: () => Promise<void> })`. Consumed by Task 6.

Presentational: renders a back button (`onBack`), the vendor name + category header, the **non-E2E notice** (exact global-constraint copy), the message list (bubbles: a message is "mine" when `m.senderProfileId === props.ownProfileId` → right-aligned gold; else left-aligned surface), a `loading`/`error` state for the list, a send box (textarea + Send button; disabled while sending or when trimmed empty; hidden entirely when `!canEdit`), and — when `props.enquiry.quotedMinor != null` — a **quote card** showing the formatted amount plus an **"Add to budget"** button (calls `onAddToBudget`; hidden when `!canEdit`). `onSend` clears the textarea on resolve; on reject it keeps the text and shows `err` via toast (toast is fine here, or an inline error — use `solid-toast` `toast.error`, matching VendorsView).

- [ ] **Step 1: Write the failing test.** Cover: (a) renders the non-E2E notice text; (b) "mine" vs "theirs" bubbles differ (assert by querying the two message bodies and checking a data attribute or alignment class you set, e.g. `data-mine="true"`); (c) typing + clicking Send calls `onSend` with the text and clears the box on resolve; (d) a quote card with "Add to budget" appears when `quotedMinor` set and clicking calls `onAddToBudget`; (e) when `canEdit={false}` the send box and Add-to-budget button are absent.

```ts
it("sends a reply and clears the box", async () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  render(() => <EnquiryThread {...base} onSend={onSend} />);
  const box = screen.getByPlaceholderText(/write a reply/i) as HTMLTextAreaElement;
  fireEvent.input(box, { target: { value: "hello there" } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello there"));
  await waitFor(() => expect(box.value).toBe(""));
});
```
(Define `base` with `enquiry` quotedMinor set, `messages` = one mine + one theirs, `ownProfileId`, `canEdit: true`, no-op async handlers.)

- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement `EnquiryThread.tsx`.** Local `sending` signal, `draft` signal; on Send call `props.onSend(draft().trim())` then `setDraft("")` in a `.then`, `catch` → `toast.error(...)`. Set `data-mine={String(m.senderProfileId === props.ownProfileId)}` on each bubble for testability. Non-E2E notice in a small `border-border bg-surface/20 text-text-muted` block.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit.** `git add cire/organiser/src/components/EnquiryThread.* && git commit -m "feat(cire/organiser): enquiry thread component"`

---

## Task 6: Organiser — EnquiriesView container + wire into Vendors module

**Files:**
- Create: `cire/organiser/src/components/EnquiriesView.tsx`
- Test: `cire/organiser/src/components/EnquiriesView.test.tsx`
- Modify: `cire/organiser/src/lib/dashboard-route.ts` (line 60: `vendors: ["index", "browse"]` → add `"enquiries"`)
- Modify: `cire/organiser/src/components/ModuleShell.tsx` (add sub-tab at line 69–72; render block at line 200–211)

**Interfaces:**
- Consumes: Tasks 2/3/4/5, `useAuth` from `@osn/client/solid`.
- Produces: `default function EnquiriesView(props: { weddingId: string; currency: string; canEdit: boolean; ownProfileId: string })`. Container: owns a `selectedId` signal (null = inbox, else thread); loads the inbox via `ensureEnquiriesLoaded(weddingId, () => fetchEnquiries(authFetch, weddingId))` in an effect; renders `<EnquiryInbox>` when `selectedId()` is null else `<EnquiryThread>` for the selected enquiry; wires `onSend` (→ `replyEnquiry` then `invalidate`+reload inbox for `lastMessageAt`/status refresh), `onAddToBudget` (→ `addEnquiryToBudget` then `toast.success`), thread messages via `createResource(selectedId, id => fetchMessages(...))`.

`ownProfileId` comes from `useAuth().session()?.profile?.id` at the ModuleShell call site (see how other views read session; if not readily available, read it inside EnquiriesView via `useAuth().session()`). Confirm the session shape from `@osn/client/solid` (used in VendorApp.test via `session: () => ({ profile: { id } })`).

- [ ] **Step 1: Write the failing test.** Mock `useAuth` (`authFetch` + `session`). Pre-seed the store with `setCachedEnquiries`, render, assert inbox row shows; click it, mock `authFetch` for `GET messages`, assert a message body renders and the non-E2E notice shows; click back, assert inbox again. Also assert the container calls `fetchEnquiries` when the store is empty. Reset store in `beforeEach` with `__resetEnquiriesCache()`.

- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3a: Implement `EnquiriesView.tsx`** per the interface above.
- [ ] **Step 3b: Wire routing.** In `dashboard-route.ts` line 60: `vendors: ["index", "browse", "enquiries"],`. In `ModuleShell.tsx`:
  - Sub-tab (after line 71): `{ id: "enquiries", label: "Enquiries" },`
  - Render (after the `browse` Show at line 210), inside the same `entitlements.includes("vendors")` guard:
    ```tsx
    <Show when={active() === "enquiries"}>
      <EnquiriesView
        weddingId={props.weddingId}
        currency={peekCachedBudget(props.weddingId)?.currency ?? "AUD"}
        canEdit={props.canEdit}
        ownProfileId={/* from useAuth().session()?.profile?.id ?? "" — add a session read at top of ModuleShell if not present */}
      />
    </Show>
    ```
  - Add `import EnquiriesView from "./EnquiriesView";` near the other imports (line 7/21). If ModuleShell has no `useAuth` yet, import it and read `const session = useAuth().session;` once; pass `session()?.profile?.id ?? ""`.
- [ ] **Step 4: Run tests, verify pass.** Run EnquiriesView test + the existing ModuleShell test if any (`bun run --cwd cire/organiser test`).
- [ ] **Step 5: Commit.** `git add -A cire/organiser && git commit -m "feat(cire/organiser): enquiries view + vendors sub-tab wiring"`

---

## Task 7: Organiser — "Enquire" entry points (directory card + CRM row)

**Files:**
- Create: `cire/organiser/src/components/EnquireDialog.tsx`
- Test: `cire/organiser/src/components/EnquireDialog.test.tsx`
- Modify: `cire/organiser/src/components/DirectoryBrowseView.tsx` (add an "Enquire" action to each card)
- Modify: `cire/organiser/src/components/VendorsView.tsx` (add an "Enquire" action to CRM rows that have `directoryVendorId`)

**Interfaces:**
- Consumes: `openEnquiry`, `enquiryErrorMessage` (Task 3), `upsertCachedEnquiry` (Task 2), `useAuth`.
- Produces: `default function EnquireDialog(props: { open: boolean; weddingId: string; directoryVendorId: string; category: string; vendorName: string; onClose: () => void; onSent?: (item: EnquiryListItem) => void })`. A modal: a message textarea + Send + Cancel. On Send → `openEnquiry(authFetch, weddingId, { directoryVendorId, category, message, vendorName })`, then `upsertCachedEnquiry(weddingId, item)`, `toast.success("Enquiry sent")`, `props.onSent?.(item)`, `props.onClose()`. On error → `toast.error(enquiryErrorMessage(err))` (note: `awaiting_vendor` is NOT an error here — the open succeeds for unclaimed vendors; only real failures reject). Read existing modal conventions from `ImageCropModal.tsx` (controlled `open` + `<Show>` + fixed overlay).

- [ ] **Step 1: Write the failing test** for `EnquireDialog`: when `open`, typing a message + clicking Send calls `authFetch` POST to `/enquiries`, then closes (assert `onClose` called and `onSent` called with the merged item). Mock `useAuth`. Also assert it renders nothing when `open={false}`.
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3a: Implement `EnquireDialog.tsx`.**
- [ ] **Step 3b: Wire DirectoryBrowseView.** Read the card block (~lines 180–188 render an "Add" control). Add an **"Enquire"** button beside "Add" that opens `EnquireDialog` with that listing's `directoryVendorId` (the listing id), the chosen/first category, and the listing name. Manage a `enquireFor` signal holding the active listing (or null). Reuse the existing category-resolution the "Add" flow uses (if the card already resolves a single category, pass it; if multi-category, default to the first — enquiring auto-adds the CRM row server-side).
- [ ] **Step 3c: Wire VendorsView.** In the CRM row actions (near the "List in directory"/status controls, ~lines 387–403), add an **"Enquire"** button **only when `vendor.directoryVendorId` is non-null** (`<Show when={vendor.directoryVendorId}>`). Open `EnquireDialog` with `directoryVendorId={vendor.directoryVendorId!}`, `category={vendor.category}`, `vendorName={vendor.name}`.
- [ ] **Step 4: Run tests, verify pass** (`EnquireDialog` test + existing DirectoryBrowseView/VendorsView tests must stay green): `bun run --cwd cire/organiser test`.
- [ ] **Step 5: Commit.** `git add -A cire/organiser && git commit -m "feat(cire/organiser): enquire entry points on directory + CRM"`

---

## Task 8: Vendor — enquiries store (pure async helpers)

**Files:**
- Create: `cire/vendor/src/lib/enquiries-store.ts`
- Test: `cire/vendor/src/lib/enquiries-store.test.ts`

**Interfaces:**
- Consumes: `apiUrl` from `./api` (+ its `ensureOk`/`safeJson` if exported; else replicate locally following `vendor-store.ts`).
- Produces: types `VendorEnquiryListItem` (EnquiryDto fields + `vendorName: string; category: string; weddingName: string`), `VendorEnquiryMessage` (= `MessageDto`); helpers `listEnquiries(authFetch)`, `getEnquiryMessages(authFetch, id)`, `replyToEnquiry(authFetch, id, message)`, `submitQuote(authFetch, id, amountMinor, note?)`; `friendlyEnquiryError(err)`. Consumed by Tasks 9, 10.

Mirror `cire/vendor/src/lib/vendor-store.ts` — pure functions taking `authFetch` first, `ensureOk` throwing the server error string, `safeJson` degradation. No module state (component signals hold state, per vendor convention).

- [ ] **Step 1: Write the failing test.** Model on `vendor-store.test.ts` (`jsonRes` helper, `vi.fn()` authFetch). Cover: `listEnquiries` GETs `/api/vendor/enquiries` and returns `body.enquiries` (assert `weddingName` passes through); `submitQuote` POSTs `{amountMinor,note}` to `/api/vendor/enquiries/:id/quote` and returns `body.enquiry`; `replyToEnquiry` POSTs `{message}` to `.../messages`; a non-2xx throws with the server `error` string.
- [ ] **Step 2: Run, verify it fails.** `bun run --cwd cire/vendor test -- enquiries-store`.
- [ ] **Step 3: Implement.**
```ts
export async function submitQuote(authFetch: AuthFetch, id: string, amountMinor: number, note?: string) {
  const res = await authFetch(apiUrl(`/api/vendor/enquiries/${encodeURIComponent(id)}/quote`), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note !== undefined ? { amountMinor, note } : { amountMinor }),
  });
  await ensureOk(res);
  const body = await safeJson<{ enquiry: VendorEnquiryListItem }>(res);
  if (!body?.enquiry) throw new Error("Invalid response submitting quote");
  return body.enquiry;
}
```
(Others analogous. If `apiUrl`/`ensureOk`/`safeJson` are not exported from `./api`, define local copies mirroring `vendor-store.ts`.)
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit.** `git add cire/vendor/src/lib/enquiries-store.* && git commit -m "feat(cire/vendor): enquiries store"`

---

## Task 9: Vendor — enquiry inbox + account-level nav wiring

**Files:**
- Create: `cire/vendor/src/components/VendorEnquiryInbox.tsx`
- Test: `cire/vendor/src/components/VendorEnquiryInbox.test.tsx`
- Modify: `cire/vendor/src/components/VendorApp.tsx` (top bar: add an "Enquiries" ⇄ "Listings" toggle at the account level; render inbox instead of OrgPicker/ListingEditor when in enquiries mode)

**Interfaces:**
- Consumes: `listEnquiries` (Task 8), `categoryLabel` from `../lib/service-categories`, `useAuth`.
- Produces: `default function VendorEnquiryInbox(props: { onOpen: (id: string) => void })`. Loads via `createResource(() => listEnquiries(authFetch))`; renders rows showing `weddingName` (the enquiring couple), `categoryLabel(category)`, status chip, quote if set, date; loading/error/empty states; each row → `props.onOpen(id)`.

- [ ] **Step 1: Write the failing test** for `VendorEnquiryInbox`: mock `useAuth` + mock `../lib/enquiries-store` `listEnquiries` to resolve one item with `weddingName: "Alex & Sam"`; assert the row shows "Alex & Sam" and the category label; click → `onOpen(id)`. (Follow `VendorApp.test.tsx` mocking style.)
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3a: Implement `VendorEnquiryInbox.tsx`.**
- [ ] **Step 3b: Wire `VendorApp.tsx`.** Add a `view` signal (`"listings" | "enquiries"`, default `"listings"`) synced to the hash (extend the existing `#/orgs/:id` hash logic minimally, e.g. `#/enquiries`). In the top bar (lines 111–131), add a toggle button set: "Listings" / "Enquiries". When `view() === "enquiries"`, render `<VendorEnquiryInbox onOpen={setSelectedEnquiryId}>` (and, when an enquiry is selected, `<VendorEnquiryThread>` from Task 10 — for THIS task, selecting can set a signal that Task 10 will consume; render a minimal `<Show when={selectedEnquiryId()}>` placeholder that Task 10 replaces). Keep the org-scoped listings flow unchanged when `view() === "listings"`.

  NOTE: to keep Task 9 independently shippable without Task 10's component, render the selected-thread area as `null` for now (inbox-only), and Task 10 swaps in the real thread. Document this in the commit.
- [ ] **Step 4: Run tests, verify pass** (inbox test + existing `VendorApp.test.tsx` stays green): `bun run --cwd cire/vendor test`.
- [ ] **Step 5: Commit.** `git add -A cire/vendor && git commit -m "feat(cire/vendor): enquiry inbox + account nav"`

---

## Task 10: Vendor — enquiry thread + quote form

**Files:**
- Create: `cire/vendor/src/components/VendorEnquiryThread.tsx`
- Test: `cire/vendor/src/components/VendorEnquiryThread.test.tsx`
- Modify: `cire/vendor/src/components/VendorApp.tsx` (render `<VendorEnquiryThread>` for the selected enquiry, replacing the Task 9 placeholder)

**Interfaces:**
- Consumes: `getEnquiryMessages`, `replyToEnquiry`, `submitQuote`, types (Task 8); `useAuth`.
- Produces: `default function VendorEnquiryThread(props: { enquiryId: string; ownProfileId: string; onBack: () => void; onQuoted?: () => void })`. Loads messages via `createResource(() => getEnquiryMessages(authFetch, props.enquiryId))`; bubbles by `senderProfileId === ownProfileId`; the **non-E2E notice**; a reply box (→ `replyToEnquiry`, refetch messages on resolve); a **quote form** (amount input in major units → convert to minor `Math.round(value * 100)`, optional note; validate amount > 0; → `submitQuote`; on resolve `toast.success` + `props.onQuoted?.()` + refetch). Currency: the vendor app has no wedding currency in context — display the amount input with a plain "$" prefix and format submitted/existing quotes with `Intl.NumberFormat(undefined, { style: "currency", currency: "AUD" })` (AUD default; acceptable for v1 — note in commit).

- [ ] **Step 1: Write the failing test.** Cover: renders the non-E2E notice; entering a valid amount + submitting calls `submitQuote` with the minor-unit integer (e.g. `1500` for `15`); amount `0`/empty disables the quote submit; a reply calls `replyToEnquiry` and refetches. Mock `../lib/enquiries-store`.

```ts
it("submits a quote in minor units", async () => {
  const submitQuote = vi.fn().mockResolvedValue({ /* enquiry */ });
  vi.mocked(store).submitQuote = submitQuote; // or mock the module
  render(() => <VendorEnquiryThread enquiryId="enq_1" ownProfileId="p" onBack={() => {}} />);
  fireEvent.input(await screen.findByLabelText(/quote amount/i), { target: { value: "15" } });
  fireEvent.click(screen.getByRole("button", { name: /send quote/i }));
  await waitFor(() => expect(submitQuote).toHaveBeenCalledWith(expect.anything(), "enq_1", 1500, undefined));
});
```
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3a: Implement `VendorEnquiryThread.tsx`.**
- [ ] **Step 3b: Wire `VendorApp.tsx`** to render `<VendorEnquiryThread enquiryId={selectedEnquiryId()!} ownProfileId={session()?.profile?.id ?? ""} onBack={() => setSelectedEnquiryId(null)} />` inside the `view() === "enquiries"` branch when an enquiry is selected, replacing the Task 9 placeholder.
- [ ] **Step 4: Run tests, verify pass.** `bun run --cwd cire/vendor test`.
- [ ] **Step 5: Commit.** `git add -A cire/vendor && git commit -m "feat(cire/vendor): enquiry thread + quote form"`

---

## Task 11: Changeset, docs, and full-suite verification

**Files:**
- Create: `.changeset/cire-vendors-enquiries-frontends.md`
- Modify: `cire/wiki/todo/web.md`, `cire/wiki/todo/platform.md`, `cire/wiki/todo/status.md` (mark PR C done / update Up Next; bump `last-reviewed` to 2026-07-21)

**Interfaces:** none (housekeeping).

- [ ] **Step 1: Write the changeset.** `@cire/*` are version-less, but CI still requires a changeset entry. Create `.changeset/cire-vendors-enquiries-frontends.md`:
```md
---
"@cire/api": patch
"@cire/organiser": patch
"@cire/vendor": patch
---

Vendors S4 PR C — enquiry frontends: couple thread (Vendors → Enquiries sub-tab) + vendor portal enquiry inbox/thread/quote form, plus the enquiring wedding name on the vendor inbox.
```
Confirm no versioned (`@zap/*`/`@shared/*`) packages are in this file. Run `bash scripts/validate-changesets.sh` if present.

- [ ] **Step 2: Update wiki shards.** In `cire/wiki/todo/web.md` and `platform.md`, check off the PR C enquiry-frontend items; in `status.md` update the Status line + Up Next. Keep edits minimal and factual. Bump each touched shard's `last-reviewed:` to `2026-07-21`.

- [ ] **Step 3: Full verification.** Run the whole affected surface:
  - `bun run --cwd cire/api test`
  - `bun run --cwd cire/organiser test`
  - `bun run --cwd cire/vendor test`
  - `bun run check` (typecheck) and `bun run lint`
  Expected: all green. Fix any fallout before committing.

- [ ] **Step 4: Commit.** `git add -A && git commit -m "chore(cire): changeset + docs for Vendors S4 PR C"`

---

## Self-Review Notes (author)

- **Spec coverage (§8):** couple thread + inbox (Tasks 4–6), Enquire from directory card + CRM row (Task 7), quote card + add-to-budget (Task 5), non-E2E notice both sides (Tasks 5, 10), vendor inbox + thread + quote form (Tasks 9–10). Backend "frontends-only" widened by the one approved addition (Task 1, wedding name). ✅
- **Type consistency:** `EnquiryListItem`/`EnquiryMessage` defined once in the organiser store (Task 2) and imported everywhere organiser-side; vendor types in the vendor store (Task 8). `openEnquiry` returns a full `EnquiryListItem` by merging caller-supplied `vendorName`/`category` onto the `{enquiry}` payload — consistent with the inbox row type.
- **Reads:** on-load + refetch-after-send/quote (no polling timer) — matches the spec's "on-load/poll for v1" with the simpler branch; a poll can be layered later.
- **Open item for reviewer:** vendor thread formats quotes in AUD (no per-wedding currency in vendor context). Acceptable for v1; flag if a mixed-currency vendor is realistic.
