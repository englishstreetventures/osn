# cire Vendors — Slice 1 PR B (Vendor Portal App + Infra) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public vendor portal at `vendor.cireweddings.com` — a new `cire/vendor` Astro + SolidJS app where a vendor signs in with an OSN passkey, creates or picks an OSN organisation, and publishes/edits their directory listing; plus a `/claim` landing that consumes an organiser's email invite — and wire the deploy job, DNS-ready allowlists, and the deferred Referrer-Policy hardening.

**Architecture:** PR A already shipped the entire backend: `/api/vendor/claims/:token` (public preview), `/api/vendor/claims/:token/consume`, `/api/vendor/orgs/:orgId/listing` (GET/PUT), all `osnAuth()` + `vendorOrgMember`-gated, plus the osn-bridge org resolvers and the `directory_vendors`/`vendor_claims` tables. PR B is a **pure frontend + infra** slice: no new cire-api routes, no migration. The new app mirrors `cire/organiser` exactly — `output: "static"` Astro with `client:only="solid-js"` islands, `@osn/client/solid` `AuthProvider`/`useAuth` for passkey sign-in and token-bearing `authFetch`, `@osn/ui` `SignIn`/`Register`, and `@cire/theme` tokens via a copied `styles/global.css`. Org create/list calls hit osn-api's `/organisations` endpoints through the same `authFetch` (one OSN access token, accepted by both osn-api and cire-api audiences); listing + claim calls hit cire-api's `/api/vendor/*`.

**Tech Stack:** Astro 6 (static output), SolidJS 1.9, `@osn/client`, `@osn/ui`, `@cire/theme`, Tailwind v4, vitest + happy-dom + `@solidjs/testing-library`, Cloudflare Pages (Direct Upload), GitHub Actions.

## Global Constraints

- **No new cire-api routes or DB migration in this PR.** The `/api/vendor/*` contract is frozen as shipped in PR A. If a screen seems to need a new endpoint, stop and escalate — do not add one here.
- **Mirror `cire/organiser` idioms verbatim** where an equivalent exists: `output: "static"`, `client:only="solid-js"`, one `AuthProvider` root island per page, `useAuth().authFetch` for every authenticated call (components call `useAuth()` directly — no fetch singleton), `redirectToLogin()` → `/login` on 401/`AuthExpiredError`.
- **All authenticated calls go through `useAuth().authFetch`.** Never read or store a raw access token; `useAuth()` does not expose one. `authFetch` attaches + silently refreshes the OSN access token, which both osn-api (`/organisations`) and cire-api (`/api/vendor/*`) accept.
- **Category keys and labels** come from a client mirror of `cire/api/src/lib/service-categories.ts` — copy `cire/organiser/src/lib/service-categories.ts` verbatim into the new app. Keys: `venue, catering, photography, videography, decor_styling, florals, music_entertainment, celebrant, cake, stationery, hair_makeup, transport, attire, other`.
- **Money is minor units** (integer cents). `priceMinMinor`/`priceMaxMinor` are optional integers; `priceBand` is one of `"$" | "$$" | "$$$" | "$$$$"` or null.
- **Claim tokens are secrets in the URL** (`/claim?token=…`). The claim page MUST (a) be served with a `Referrer-Policy` that never leaks the query string cross-origin, and (b) strip the token from the visible URL via `history.replaceState` immediately after reading it.
- **Package versioning:** `@cire/*` packages are UNVERSIONED (`version: null` → an EMPTY changeset covers all cire changes). The osn-api allowlist edit is a VERSIONED `@osn/api` change → its own patch changeset, in a SEPARATE file from the cire empty changeset. Never mix ignored + versioned packages in one changeset file. `scripts/validate-changesets.sh` enforces this.
- **cire/vendor `package.json` name is `@cire/vendor`**, `private: true`, `type: "module"`. It is picked up by the root bun workspace `packages` glob automatically (same as `@cire/organiser`).

---

## File Structure

New app under `cire/vendor/` (mirrors `cire/organiser/`):

- `cire/vendor/package.json` — `@cire/vendor`; deps mirror organiser minus the invite-only ones (drop `cropperjs`; keep `@osn/client`, `@osn/ui`, `@cire/theme`, `@kobalte/core`, `@simplewebauthn/browser`, solid, astro, tailwind, solid-toast).
- `cire/vendor/astro.config.mjs` — identical to organiser (`output: "static"`, solid + tailwind).
- `cire/vendor/tsconfig.json` — identical to organiser.
- `cire/vendor/src/env.d.ts` — `PUBLIC_OSN_ISSUER_URL`, `PUBLIC_CIRE_API_URL`, `PUBLIC_API_URL` (legacy), `PUBLIC_TURNSTILE_SITEKEY`.
- `cire/vendor/src/styles/global.css` — copied verbatim from organiser (theme tokens + `@source` for `@osn/ui`).
- `cire/vendor/src/lib/osn.ts` — `OSN_ISSUER_URL`, `CIRE_API_URL` (drop `CIRE_WEB_URL` — unused in the portal).
- `cire/vendor/src/lib/api.ts` — `apiUrl`, `isAuthExpired`, `redirectToLogin` (copied verbatim from organiser).
- `cire/vendor/src/lib/service-categories.ts` — copied verbatim from organiser.
- `cire/vendor/src/lib/vendor-store.ts` — pure `authFetch`-taking async helpers + response types (org list/create, listing get/put, claim preview/consume).
- `cire/vendor/src/components/SignInPanel.tsx` — mirror organiser, reworded "Vendor Portal".
- `cire/vendor/src/components/OrgPicker.tsx` — list my orgs + "create new org" form.
- `cire/vendor/src/components/ListingEditor.tsx` — the listing form (name, categories multi-select, description, contact, location, price band/min/max, publish state read-only display).
- `cire/vendor/src/components/VendorApp.tsx` — root island: `AuthProvider` + `RequireAuth` + hash-routed org-pick ↔ editor.
- `cire/vendor/src/components/ClaimApp.tsx` — root island for `/claim`: unauth preview → sign-in → org pick → consume.
- `cire/vendor/src/pages/login.astro`, `index.astro`, `claim.astro`.
- `cire/vendor/public/_headers` — Cloudflare Pages headers incl. `Referrer-Policy`.
- `cire/vendor/vitest.config.ts` + `cire/vendor/src/test-setup.ts` — mirror organiser test harness (if organiser has them; otherwise create minimal happy-dom config).

Infra / config (existing files):
- `.github/workflows/deploy.yml` — add `deploy-cire-vendor` job.
- `cire/api/wrangler.toml` — widen `WEB_ORIGIN`.
- `osn/api/wrangler.toml` — widen `OSN_ORIGIN` / `OSN_CORS_ORIGIN`.
- `.changeset/*.md` — one empty cire changeset + one `@osn/api` patch changeset.
- `cire/wiki/systems/vendors.md`, `cire/wiki/runbooks/production-deploy.md` — portal deploy + first-run steps.

---

### Task 1: Scaffold the `cire/vendor` app (builds an empty shell)

**Files:**
- Create: `cire/vendor/package.json`
- Create: `cire/vendor/astro.config.mjs`
- Create: `cire/vendor/tsconfig.json`
- Create: `cire/vendor/src/env.d.ts`
- Create: `cire/vendor/src/styles/global.css`
- Create: `cire/vendor/src/lib/osn.ts`
- Create: `cire/vendor/src/lib/api.ts`
- Create: `cire/vendor/src/lib/service-categories.ts`
- Create: `cire/vendor/src/pages/index.astro` (temporary placeholder body, replaced in Task 6)

**Interfaces:**
- Produces: `OSN_ISSUER_URL`, `CIRE_API_URL` (from `lib/osn.ts`); `apiUrl(path)`, `isAuthExpired(err)`, `redirectToLogin()` (from `lib/api.ts`); `SERVICE_CATEGORIES`, `categoryLabel(key)`, `ServiceCategory` (from `lib/service-categories.ts`).

- [ ] **Step 1: Copy the scaffold files verbatim from `cire/organiser`**

`package.json` — start from `cire/organiser/package.json`, then: change `"name"` to `"@cire/vendor"`, change the `dev` script port from `4322` to `4323` (avoid clashing with organiser during local dev), and **remove `"cropperjs": "^2.1.1"`** (image cropping is invite-only). Keep everything else identical.

```json
{
  "name": "@cire/vendor",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port 4323",
    "build": "astro build",
    "preview": "astro preview",
    "test": "bunx --bun vitest",
    "test:run": "bunx --bun vitest run"
  },
  "dependencies": {
    "@astrojs/solid-js": "^6.0.1",
    "@cire/theme": "workspace:*",
    "@kobalte/core": "^0.13.11",
    "@osn/client": "workspace:*",
    "@osn/ui": "workspace:*",
    "@simplewebauthn/browser": "^13.3.0",
    "@tailwindcss/vite": "^4.3.0",
    "astro": "^6.4.6",
    "solid-js": "^1.9.13",
    "solid-toast": "^0.5.0",
    "tailwindcss": "^4.3.0"
  },
  "devDependencies": {
    "@shared/typescript-config": "workspace:*",
    "@solidjs/testing-library": "^0.8.10",
    "@testing-library/jest-dom": "^6.9.1",
    "happy-dom": "^20.9.0",
    "vite": "^8.0.13",
    "vite-plugin-solid": "^2.11.12",
    "vitest": "^4.1.8"
  }
}
```

`astro.config.mjs` — copy `cire/organiser/astro.config.mjs` verbatim (no changes).

`tsconfig.json` — copy `cire/organiser/tsconfig.json` verbatim.

`src/env.d.ts` — copy `cire/organiser/src/env.d.ts` verbatim.

`src/styles/global.css` — copy `cire/organiser/src/styles/global.css` verbatim. **Verify the `@source` relative path still resolves**: organiser uses `@source "../../../../osn/ui/src";` — from `cire/vendor/src/styles/` the depth to repo root is identical (`cire/vendor/src/styles` == `cire/organiser/src/styles` in segment count), so the same `../../../../osn/ui/src` is correct. Keep it verbatim.

- [ ] **Step 2: Write `src/lib/osn.ts`**

```ts
// Issuer origin for the OSN identity API. Dev default matches `bun run
// dev:cire` which starts @osn/api on :4000.
export const OSN_ISSUER_URL = import.meta.env.PUBLIC_OSN_ISSUER_URL ?? "http://localhost:4000";

// cire/api origin. Dev default matches @cire/api's `bun run dev`
// (src/local.ts, port 8787). PUBLIC_API_URL is the legacy name, still
// honoured as a fallback.
export const CIRE_API_URL =
  import.meta.env.PUBLIC_CIRE_API_URL ?? import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787";
```

- [ ] **Step 3: Write `src/lib/api.ts`** — copy `cire/organiser/src/lib/api.ts` verbatim (its `apiUrl`/`isAuthExpired`/`redirectToLogin` are portal-agnostic).

- [ ] **Step 4: Write `src/lib/service-categories.ts`** — copy `cire/organiser/src/lib/service-categories.ts` verbatim.

- [ ] **Step 5: Write a temporary `src/pages/index.astro` placeholder**

```astro
---
import '../styles/global.css'
---
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vendor Portal — Cire</title>
  </head>
  <body>
    <main class="mx-auto max-w-[720px] px-8 py-12">
      <h1 class="font-display text-text text-[2rem] font-light italic">Vendor Portal</h1>
    </main>
  </body>
</html>
```

- [ ] **Step 6: Install workspace deps and build**

Run (from repo root — the new package needs to be linked into the workspace):
```bash
bun install
bun run --cwd cire/vendor build
```
Expected: `bun install` links `@cire/vendor`; the build completes and writes `cire/vendor/dist/index.html`. Fix any Tailwind `@source` or import errors before proceeding.

- [ ] **Step 7: Commit**

```bash
git add cire/vendor bun.lock
git commit -m "feat(cire/vendor): scaffold vendor portal Astro app shell"
```

---

### Task 2: `vendor-store.ts` — the data layer (authFetch helpers)

**Files:**
- Create: `cire/vendor/src/lib/vendor-store.ts`
- Test: `cire/vendor/src/lib/vendor-store.test.ts`

**Interfaces:**
- Consumes: `apiUrl` from `lib/api.ts`, `OSN_ISSUER_URL` from `lib/osn.ts`.
- Produces (each takes an `authFetch` = `(input, init?) => Promise<Response>` as its first arg, except `fetchClaimPreview` which uses plain `fetch`):
  - `type OrgSummary = { id: string; handle: string; name: string; description: string | null; avatarUrl: string | null; ownerId: string; createdAt: string; updatedAt: string }`
  - `type Listing = { id: string; ownerOrgId: string | null; name: string; description: string | null; email: string | null; phone: string | null; website: string | null; instagram: string | null; locationText: string | null; priceBand: string | null; priceMinMinor: number | null; priceMaxMinor: number | null; listed: string; categories: string[] }`
  - `type ClaimPreview = { directoryVendorId: string; name: string }`
  - `type ListingInput = { name: string; categories: string[]; description?: string | null; email?: string | null; phone?: string | null; website?: string | null; instagram?: string | null; locationText?: string | null; priceBand?: string | null; priceMinMinor?: number | null; priceMaxMinor?: number | null }`
  - `listMyOrgs(authFetch): Promise<OrgSummary[]>`
  - `createOrg(authFetch, data: { handle: string; name: string; description?: string }): Promise<OrgSummary>`
  - `fetchListing(authFetch, orgId: string): Promise<Listing | null>`
  - `putListing(authFetch, orgId: string, input: ListingInput): Promise<Listing>`
  - `fetchClaimPreview(token: string): Promise<ClaimPreview | null>` (plain fetch; `null` on 404)
  - `consumeClaim(authFetch, token: string, orgId: string): Promise<Listing>`

> **Note on response shapes:** the exact `Listing` field names must match what cire-api returns. Before writing tests, the implementer MUST read `cire/api/src/services/directory.ts` (the `getListingByOrg`/`upsertListingForOrg`/`consumeClaim` return shape) and `cire/api/src/routes/vendor-portal.ts` (each handler wraps the result as `{ listing }` or `{ listing: preview }`). Mirror those field names exactly; adjust the `Listing`/`ClaimPreview` types above if the service returns different casing. The claim preview route returns `{ listing: { directoryVendorId, name } }`.

- [ ] **Step 1: Write the failing test** (`vendor-store.test.ts`)

```ts
import { describe, expect, it, vi } from "vitest";
import {
  consumeClaim,
  createOrg,
  fetchClaimPreview,
  fetchListing,
  listMyOrgs,
  putListing,
} from "./vendor-store";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("vendor-store", () => {
  it("listMyOrgs GETs osn-api /organisations and returns the array", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ organisations: [{ id: "o1", handle: "h", name: "N", description: null, avatarUrl: null, ownerId: "p", createdAt: "", updatedAt: "" }] }));
    const orgs = await listMyOrgs(authFetch);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.id).toBe("o1");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/organisations");
  });

  it("createOrg POSTs handle+name and returns the org", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ id: "o2", handle: "acme", name: "Acme", description: null, avatarUrl: null, ownerId: "p", createdAt: "", updatedAt: "" }));
    const org = await createOrg(authFetch, { handle: "acme", name: "Acme" });
    expect(org.id).toBe("o2");
    const init = authFetch.mock.calls[0]![1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ handle: "acme", name: "Acme" });
  });

  it("fetchListing returns the listing on 200", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ listing: { id: "l1", ownerOrgId: "o1", name: "N", categories: ["venue"] } }));
    const listing = await fetchListing(authFetch, "o1");
    expect(listing!.id).toBe("l1");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/vendor/orgs/o1/listing");
  });

  it("fetchListing returns null when the org has no listing (listing: null)", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ listing: null }));
    expect(await fetchListing(authFetch, "o1")).toBeNull();
  });

  it("putListing PUTs the body and returns the saved listing", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ listing: { id: "l1", name: "New", categories: ["venue", "catering"] } }));
    const saved = await putListing(authFetch, "o1", { name: "New", categories: ["venue", "catering"] });
    expect(saved.name).toBe("New");
    const init = authFetch.mock.calls[0]![1];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toMatchObject({ name: "New", categories: ["venue", "catering"] });
  });

  it("fetchClaimPreview returns the preview on 200 and null on 404", async () => {
    const g = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonRes({ listing: { directoryVendorId: "d1", name: "Preview Co" } }));
    expect(await fetchClaimPreview("tok")).toEqual({ directoryVendorId: "d1", name: "Preview Co" });
    g.mockResolvedValueOnce(jsonRes({ error: "claim_not_found" }, 404));
    expect(await fetchClaimPreview("tok")).toBeNull();
    g.mockRestore();
  });

  it("consumeClaim POSTs {orgId} to the consume route and returns the listing", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ listing: { id: "l1", ownerOrgId: "o1", name: "N", categories: [] } }));
    const listing = await consumeClaim(authFetch, "tok", "o1");
    expect(listing.ownerOrgId).toBe("o1");
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/vendor/claims/tok/consume");
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toEqual({ orgId: "o1" });
  });

  it("putListing throws with the server error message on non-2xx", async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonRes({ error: "not_org_member" }, 403));
    await expect(putListing(authFetch, "o1", { name: "x", categories: ["venue"] })).rejects.toThrow(/not_org_member/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd cire/vendor test:run src/lib/vendor-store.test.ts`
Expected: FAIL — `vendor-store.ts` does not exist / exports undefined.

- [ ] **Step 3: Write `vendor-store.ts`**

```ts
// Data layer for the vendor portal. Pure async helpers over `authFetch`
// (from useAuth()) — no module-level auth state, mirroring how the organiser
// app threads authFetch into its stores. Org create/list hit osn-api
// (/organisations); listing + claim hit cire-api (/api/vendor/*). One OSN
// access token is accepted by both audiences.
import { apiUrl } from "./api";
import { OSN_ISSUER_URL } from "./osn";

type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OrgSummary {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Listing {
  id: string;
  ownerOrgId: string | null;
  name: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  locationText: string | null;
  priceBand: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  listed: string;
  categories: string[];
}

export interface ClaimPreview {
  directoryVendorId: string;
  name: string;
}

export interface ListingInput {
  name: string;
  categories: string[];
  description?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  instagram?: string | null;
  locationText?: string | null;
  priceBand?: string | null;
  priceMinMinor?: number | null;
  priceMaxMinor?: number | null;
}

const ORG_BASE = `${OSN_ISSUER_URL.replace(/\/$/, "")}/organisations`;

/** Read the response as JSON, or null if the body isn't JSON. */
async function safeJson<T>(res: Response): Promise<(T & { error?: string }) | null> {
  try {
    return (await res.json()) as T & { error?: string };
  } catch {
    return null;
  }
}

/** Throw a trimmed server error message on non-2xx. */
async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await safeJson<{ error?: string }>(res);
  const msg = typeof body?.error === "string" && body.error.length > 0 ? body.error : `Request failed: ${res.status}`;
  throw new Error(msg.length > 200 ? `${msg.slice(0, 200)}…` : msg);
}

export async function listMyOrgs(authFetch: AuthFetch): Promise<OrgSummary[]> {
  const res = await authFetch(ORG_BASE);
  await ensureOk(res);
  const body = await safeJson<{ organisations: OrgSummary[] }>(res);
  return body?.organisations ?? [];
}

export async function createOrg(
  authFetch: AuthFetch,
  data: { handle: string; name: string; description?: string },
): Promise<OrgSummary> {
  const res = await authFetch(ORG_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await ensureOk(res);
  const body = await safeJson<OrgSummary>(res);
  if (!body) throw new Error("Invalid response creating organisation");
  return body;
}

export async function fetchListing(authFetch: AuthFetch, orgId: string): Promise<Listing | null> {
  const res = await authFetch(apiUrl(`/api/vendor/orgs/${encodeURIComponent(orgId)}/listing`));
  await ensureOk(res);
  const body = await safeJson<{ listing: Listing | null }>(res);
  return body?.listing ?? null;
}

export async function putListing(
  authFetch: AuthFetch,
  orgId: string,
  input: ListingInput,
): Promise<Listing> {
  const res = await authFetch(apiUrl(`/api/vendor/orgs/${encodeURIComponent(orgId)}/listing`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res);
  const body = await safeJson<{ listing: Listing }>(res);
  if (!body?.listing) throw new Error("Invalid response saving listing");
  return body.listing;
}

export async function fetchClaimPreview(token: string): Promise<ClaimPreview | null> {
  const res = await fetch(apiUrl(`/api/vendor/claims/${encodeURIComponent(token)}`));
  if (res.status === 404) return null;
  await ensureOk(res);
  const body = await safeJson<{ listing: ClaimPreview }>(res);
  return body?.listing ?? null;
}

export async function consumeClaim(
  authFetch: AuthFetch,
  token: string,
  orgId: string,
): Promise<Listing> {
  const res = await authFetch(apiUrl(`/api/vendor/claims/${encodeURIComponent(token)}/consume`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId }),
  });
  await ensureOk(res);
  const body = await safeJson<{ listing: Listing }>(res);
  if (!body?.listing) throw new Error("Invalid response consuming claim");
  return body.listing;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd cire/vendor test:run src/lib/vendor-store.test.ts`
Expected: PASS (all cases). If the `Listing` field names differ from the service, reconcile the type + test against the real service shape (see the note above) and re-run.

- [ ] **Step 5: Commit**

```bash
git add cire/vendor/src/lib/vendor-store.ts cire/vendor/src/lib/vendor-store.test.ts
git commit -m "feat(cire/vendor): vendor-store data layer over authFetch"
```

---

### Task 3: Sign-in page (`login.astro` + `SignInPanel`)

**Files:**
- Create: `cire/vendor/src/components/SignInPanel.tsx`
- Create: `cire/vendor/src/pages/login.astro`
- Test: `cire/vendor/src/components/SignInPanel.test.tsx`

**Interfaces:**
- Consumes: `OSN_ISSUER_URL` from `lib/osn.ts`.
- Produces: default-exported `SignInPanel` component (renders `SignIn`/`Register` inside `AuthProvider`, redirects to `/` on success).

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import SignInPanel from "./SignInPanel";

describe("SignInPanel", () => {
  it("renders the sign-in form with a create-account switch", () => {
    render(() => <SignInPanel />);
    // @osn/ui SignIn renders a passkey sign-in button; the panel adds a
    // "Create an account" switch to the registration flow.
    expect(screen.getByText(/create an account/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/vendor test:run src/components/SignInPanel.test.tsx`
Expected: FAIL — `SignInPanel` does not exist.

- [ ] **Step 3: Write `SignInPanel.tsx`** — copy `cire/organiser/src/components/SignInPanel.tsx` verbatim. It already redirects to `/` on success and needs no portal-specific change (the OSN account is shared; a vendor and an organiser are the same OSN identity type). Keep the file identical.

- [ ] **Step 4: Write `login.astro`** — copy `cire/organiser/src/pages/login.astro` and change the two copy strings: the `<title>` to `Login — Vendor — Cire` and the eyebrow `<p>` text from `Organiser Portal` to `Vendor Portal`. Keep the layout, fonts, and `<SignInPanel client:only="solid-js" />` mount identical.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run --cwd cire/vendor test:run src/components/SignInPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cire/vendor/src/components/SignInPanel.tsx cire/vendor/src/pages/login.astro cire/vendor/src/components/SignInPanel.test.tsx
git commit -m "feat(cire/vendor): sign-in page"
```

---

### Task 4: `OrgPicker` — list + create OSN organisations

**Files:**
- Create: `cire/vendor/src/components/OrgPicker.tsx`
- Test: `cire/vendor/src/components/OrgPicker.test.tsx`

**Interfaces:**
- Consumes: `listMyOrgs`, `createOrg`, `OrgSummary` from `lib/vendor-store.ts`; `useAuth` from `@osn/client/solid`.
- Produces: `OrgPicker` component with props `{ onPick: (org: OrgSummary) => void }`. Fetches the caller's orgs on mount via `useAuth().authFetch`; renders each as a selectable row; renders a "Create a new organisation" form (handle + name + optional description) that POSTs and then calls `onPick` with the created org.

> The org-membership gate on cire-api (`vendorOrgMember`) accepts BOTH `admin` and `member` roles, so the pick list shows every org the caller belongs to (`listMyOrgs`) without client-side role filtering. Handle validation: trim, lowercase; the server rejects duplicates/invalid handles — surface its error message inline.

- [ ] **Step 1: Write the failing test**

```tsx
import { AuthProvider } from "@osn/client/solid";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import OrgPicker from "./OrgPicker";
import * as store from "../lib/vendor-store";

const org = (id: string, name: string) => ({
  id, handle: name.toLowerCase(), name, description: null, avatarUrl: null,
  ownerId: "p", createdAt: "", updatedAt: "",
});

afterEach(() => vi.restoreAllMocks());

const renderPicker = (onPick = vi.fn()) =>
  render(() => (
    <AuthProvider config={{ issuerUrl: "http://localhost:4000" }}>
      <OrgPicker onPick={onPick} />
    </AuthProvider>
  ));

describe("OrgPicker", () => {
  it("lists the caller's organisations and picks one on click", async () => {
    vi.spyOn(store, "listMyOrgs").mockResolvedValue([org("o1", "Acme"), org("o2", "Bloom")]);
    const onPick = vi.fn();
    renderPicker(onPick);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Bloom"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "o2" }));
  });

  it("creates a new organisation and picks it", async () => {
    vi.spyOn(store, "listMyOrgs").mockResolvedValue([]);
    const created = org("o9", "NewCo");
    vi.spyOn(store, "createOrg").mockResolvedValue(created);
    const onPick = vi.fn();
    renderPicker(onPick);
    await waitFor(() => expect(screen.getByLabelText(/handle/i)).toBeInTheDocument());
    fireEvent.input(screen.getByLabelText(/handle/i), { target: { value: "newco" } });
    fireEvent.input(screen.getByLabelText(/name/i), { target: { value: "NewCo" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(created));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/vendor test:run src/components/OrgPicker.test.tsx`
Expected: FAIL — `OrgPicker` does not exist.

- [ ] **Step 3: Write `OrgPicker.tsx`**

Implement with SolidJS: `useAuth()` for `authFetch`; `createResource` to `listMyOrgs(authFetch)`; render the list (each org a `<button>` showing `org.name` + `@handle`, calling `props.onPick(org)`); a create form with labelled inputs `Handle`, `Name`, `Description (optional)`; on submit call `createOrg(authFetch, { handle, name, description })`, then `props.onPick(created)` and append to the local list. Show `store` error messages inline (`try/catch`, `createSignal` for the error string). Use `@cire/theme` utility classes matching the organiser look (`font-body`, `text-gold`, `border-border`, `bg-surface`, etc.). Inputs MUST be associated with their labels (`<label for>` / `id`) so `getByLabelText` resolves. Disable the create button while the request is in-flight.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd cire/vendor test:run src/components/OrgPicker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cire/vendor/src/components/OrgPicker.tsx cire/vendor/src/components/OrgPicker.test.tsx
git commit -m "feat(cire/vendor): OrgPicker list + create organisations"
```

---

### Task 5: `ListingEditor` — edit + publish the directory listing

**Files:**
- Create: `cire/vendor/src/components/ListingEditor.tsx`
- Test: `cire/vendor/src/components/ListingEditor.test.tsx`

**Interfaces:**
- Consumes: `fetchListing`, `putListing`, `Listing`, `ListingInput` from `lib/vendor-store.ts`; `SERVICE_CATEGORIES`, `categoryLabel` from `lib/service-categories.ts`; `useAuth` from `@osn/client/solid`.
- Produces: `ListingEditor` component with props `{ orgId: string; orgName: string }`. Loads the org's listing on mount (may be `null` — a brand-new org with no listing yet → start an empty form); renders fields: name (required), categories (multi-select checkboxes, ≥1 required), description, email, phone, website, instagram, location text, price band (`$`/`$$`/`$$$`/`$$$$`/none), price min/max (currency inputs → minor units). On save calls `putListing(authFetch, orgId, input)` and shows a success toast; shows the current `listed` state (`draft`/`live`) as a badge.

> Money inputs: display in major units (e.g. dollars) but send `priceMinMinor`/`priceMaxMinor` as integers (`Math.round(value * 100)`). Empty money input → send `null`. A brand-new org with no listing yet returns `listing: null` from `fetchListing`; the editor renders an empty form and the first save creates the listing via PUT (the server upserts). Categories multi-select must send at least one; disable Save until name is non-empty and ≥1 category is checked.

- [ ] **Step 1: Write the failing test**

```tsx
import { AuthProvider } from "@osn/client/solid";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import ListingEditor from "./ListingEditor";
import * as store from "../lib/vendor-store";

const listing = (over = {}) => ({
  id: "l1", ownerOrgId: "o1", name: "Acme Venues", description: "Nice", email: null,
  phone: null, website: null, instagram: null, locationText: "Sydney", priceBand: "$$",
  priceMinMinor: null, priceMaxMinor: null, listed: "live", categories: ["venue"], ...over,
});

afterEach(() => vi.restoreAllMocks());

const renderEditor = () =>
  render(() => (
    <AuthProvider config={{ issuerUrl: "http://localhost:4000" }}>
      <ListingEditor orgId="o1" orgName="Acme" />
    </AuthProvider>
  ));

describe("ListingEditor", () => {
  it("loads the existing listing into the form", async () => {
    vi.spyOn(store, "fetchListing").mockResolvedValue(listing());
    renderEditor();
    await waitFor(() => expect(screen.getByDisplayValue("Acme Venues")).toBeInTheDocument());
    expect((screen.getByLabelText("Venue") as HTMLInputElement).checked).toBe(true);
  });

  it("saves edits via putListing", async () => {
    vi.spyOn(store, "fetchListing").mockResolvedValue(listing());
    const put = vi.spyOn(store, "putListing").mockResolvedValue(listing({ name: "Acme Weddings" }));
    renderEditor();
    await waitFor(() => expect(screen.getByDisplayValue("Acme Venues")).toBeInTheDocument());
    fireEvent.input(screen.getByLabelText(/^name/i), { target: { value: "Acme Weddings" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(expect.anything(), "o1", expect.objectContaining({ name: "Acme Weddings", categories: ["venue"] })),
    );
  });

  it("renders an empty form when the org has no listing yet", async () => {
    vi.spyOn(store, "fetchListing").mockResolvedValue(null);
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText(/^name/i)).toHaveValue(""));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/vendor test:run src/components/ListingEditor.test.tsx`
Expected: FAIL — `ListingEditor` does not exist.

- [ ] **Step 3: Write `ListingEditor.tsx`**

Implement with SolidJS `createResource(() => fetchListing(authFetch, props.orgId))`; a `createStore`/signals-backed form seeded from the loaded listing (or empty when null). Render category checkboxes from `SERVICE_CATEGORIES` (label via `categoryLabel`), each `<label>` wrapping/for-linked to a checkbox whose accessible name is the category label. Money fields: seed from `priceMinMinor != null ? priceMinMinor / 100 : ""`; on save convert back with `Math.round(Number(v) * 100)` or `null` when blank. `handleSave` builds `ListingInput` and calls `putListing`; `solid-toast` success/error. Show `listed` badge. Disable Save when `name` is blank or no category checked. Match organiser visual idiom.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd cire/vendor test:run src/components/ListingEditor.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cire/vendor/src/components/ListingEditor.tsx cire/vendor/src/components/ListingEditor.test.tsx
git commit -m "feat(cire/vendor): ListingEditor"
```

---

### Task 6: `VendorApp` root + `index.astro` (auth gate + org→editor routing)

**Files:**
- Create: `cire/vendor/src/components/VendorApp.tsx`
- Modify: `cire/vendor/src/pages/index.astro` (replace the Task 1 placeholder)
- Test: `cire/vendor/src/components/VendorApp.test.tsx`

**Interfaces:**
- Consumes: `AuthProvider`, `useAuth` from `@osn/client/solid`; `OSN_ISSUER_URL` from `lib/osn.ts`; `redirectToLogin` from `lib/api.ts`; `OrgPicker`, `ListingEditor`, `OrgSummary`.
- Produces: default-exported `VendorApp` root island. Mirrors `OrganiserApp`'s structure: `AuthProvider` → `RequireAuth` (redirect to `/login` when `session()` is `null`, spinner while `undefined`) → a `Dashboard` that shows `OrgPicker` until an org is chosen, then `ListingEditor` for that org, with a "← All organisations" back link and a "Sign out" action. Selected org is mirrored into the URL hash (`#/orgs/:orgId`) so refresh restores it (mirror organiser's hash pattern, simplified to a single id).

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

// Mock @osn/client/solid so we control the session/authFetch without a real
// OSN backend — mirror the organiser app's VendorApp/OrganiserApp test harness.
vi.mock("@osn/client/solid", () => {
  return {
    AuthProvider: (props: any) => props.children,
    useAuth: () => ({
      session: () => ({ profile: { id: "p1" } }),
      authFetch: vi.fn(),
      logout: vi.fn(),
    }),
  };
});
vi.mock("../lib/vendor-store", () => ({
  listMyOrgs: vi.fn().mockResolvedValue([
    { id: "o1", handle: "acme", name: "Acme", description: null, avatarUrl: null, ownerId: "p1", createdAt: "", updatedAt: "" },
  ]),
  fetchListing: vi.fn().mockResolvedValue(null),
}));

import VendorApp from "./VendorApp";

describe("VendorApp", () => {
  it("shows the org picker when signed in and no org is selected", async () => {
    render(() => <VendorApp />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/vendor test:run src/components/VendorApp.test.tsx`
Expected: FAIL — `VendorApp` does not exist.

- [ ] **Step 3: Write `VendorApp.tsx`**

Model on `cire/organiser/src/components/OrganiserApp.tsx` but far simpler:
- `RequireAuth` identical (redirect to `/login` on `session() === null`).
- `Dashboard`: `const { logout } = useAuth();` a `selectedOrg` signal (`OrgSummary | null`), seeded from the hash (`#/orgs/:id` → look up after `OrgPicker` loads, or just store the id and pass to `ListingEditor`). Simplest correct approach: store `selectedOrgId` signal + `selectedOrgName`; when null render `<OrgPicker onPick={(o) => { setSelected(o); setHash(o.id); }} />`; else render a header with "← All organisations" (clears selection + hash) and `<ListingEditor orgId={id} orgName={name} />`. Keep a `hashchange` listener to re-sync (mirror organiser). Sign-out calls `logout()` then `redirectToLogin()`.
- Root: `AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}` + `RequireAuth` + `Toaster`.

- [ ] **Step 4: Write `index.astro`** — copy the Task 1 placeholder structure but mount `VendorApp`:

```astro
---
import '../styles/global.css'
import VendorApp from '../components/VendorApp'
---
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vendor Portal — Cire</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Lato:wght@300;400&display=swap" rel="stylesheet" />
  </head>
  <body>
    <main class="mx-auto max-w-[900px] px-8 py-12">
      <header class="mb-8 flex flex-col gap-2">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">Vendor Portal</p>
        <h1 class="font-display text-text text-[clamp(2rem,5vw,3.5rem)] font-light italic leading-[1.1]">Your business</h1>
      </header>
      <VendorApp client:only="solid-js" />
    </main>
  </body>
</html>
```

- [ ] **Step 5: Run the test + build**

Run: `bun run --cwd cire/vendor test:run src/components/VendorApp.test.tsx && bun run --cwd cire/vendor build`
Expected: test PASS; build writes `dist/index.html` + `dist/login/index.html`.

- [ ] **Step 6: Commit**

```bash
git add cire/vendor/src/components/VendorApp.tsx cire/vendor/src/pages/index.astro cire/vendor/src/components/VendorApp.test.tsx
git commit -m "feat(cire/vendor): app root + org→editor routing"
```

---

### Task 7: `ClaimApp` + `claim.astro` (invite claim landing)

**Files:**
- Create: `cire/vendor/src/components/ClaimApp.tsx`
- Create: `cire/vendor/src/pages/claim.astro`
- Test: `cire/vendor/src/components/ClaimApp.test.tsx`

**Interfaces:**
- Consumes: `fetchClaimPreview`, `consumeClaim`, `ClaimPreview` from `lib/vendor-store.ts`; `AuthProvider`, `useAuth` from `@osn/client/solid`; `OrgPicker`; `SignIn` from `@osn/ui/auth` (or reuse `SignInPanel` inline); `OSN_ISSUER_URL`.
- Produces: default-exported `ClaimApp` root island. Flow: read `token` from `location.search`; **immediately `history.replaceState` to strip it from the visible URL** (keep it in a signal). Fetch the unauth preview (`fetchClaimPreview`) → show "You've been invited to claim **{name}**". If `session()` is null → render sign-in inline. Once signed in → render `OrgPicker` ("Choose or create the organisation that owns this listing"). On pick → `consumeClaim(authFetch, token, org.id)` → on success redirect to `/` (`window.location.href = "/#/orgs/" + org.id`). Invalid/expired/consumed token → the preview 404s or consume returns 410 → show a generic "This invite link is no longer valid" message.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

vi.mock("@osn/client/solid", () => ({
  AuthProvider: (props: any) => props.children,
  useAuth: () => ({ session: () => ({ profile: { id: "p1" } }), authFetch: vi.fn() }),
}));
vi.mock("../lib/vendor-store", () => ({
  fetchClaimPreview: vi.fn().mockResolvedValue({ directoryVendorId: "d1", name: "Preview Co" }),
  consumeClaim: vi.fn(),
  listMyOrgs: vi.fn().mockResolvedValue([]),
}));

// Seed the token into the URL before the component reads it.
history.replaceState(null, "", "/claim?token=abc123");

import ClaimApp from "./ClaimApp";

describe("ClaimApp", () => {
  it("previews the invited listing name and strips the token from the URL", async () => {
    render(() => <ClaimApp />);
    await waitFor(() => expect(screen.getByText(/Preview Co/)).toBeInTheDocument());
    expect(window.location.search).not.toContain("abc123");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/vendor test:run src/components/ClaimApp.test.tsx`
Expected: FAIL — `ClaimApp` does not exist.

- [ ] **Step 3: Write `ClaimApp.tsx`** per the flow above. Read token in `onMount` (guard `typeof window`), stash in a signal, `history.replaceState(null, "", "/claim")`. `createResource` for the preview. Gate on `session()`: null → inline `SignInPanel` (import the Task 3 component) with a note that the page returns here after sign-in — since `SignInPanel` redirects to `/` on success, instead render `SignIn` from `@osn/ui/auth` directly with `onSuccess={() => {}}` (session adoption re-renders into the org-pick step). Signed-in → `OrgPicker onPick={handleClaim}`. `handleClaim(org)` → `consumeClaim(authFetch, token, org.id)`; on success `window.location.href = "/#/orgs/" + org.id`; on error set a generic invalid-link message. Wrap everything in `AuthProvider`.

- [ ] **Step 4: Write `claim.astro`** — same `<head>` as `index.astro` (fonts), `<title>Claim your listing — Vendor — Cire</title>`, mount `<ClaimApp client:only="solid-js" />` inside a `max-w-[560px]` main.

- [ ] **Step 5: Run the test + build**

Run: `bun run --cwd cire/vendor test:run src/components/ClaimApp.test.tsx && bun run --cwd cire/vendor build`
Expected: test PASS; build writes `dist/claim/index.html`.

- [ ] **Step 6: Commit**

```bash
git add cire/vendor/src/components/ClaimApp.tsx cire/vendor/src/pages/claim.astro cire/vendor/src/components/ClaimApp.test.tsx
git commit -m "feat(cire/vendor): claim landing page"
```

---

### Task 8: Security headers (`public/_headers`) + full suite green

**Files:**
- Create: `cire/vendor/public/_headers`
- Test: `cire/vendor/src/lib/headers.test.ts` (asserts the `_headers` file contents)

**Interfaces:** none (static asset).

> **Why (deferred S-L3):** the claim URL carries a secret token in the query string. Without a restrictive `Referrer-Policy`, the `Referer` header on the page's cross-origin subresource requests (e.g. Google Fonts) would leak the full URL — including the token — to third parties. `strict-origin-when-cross-origin` sends only the origin (no path/query) on cross-origin requests, closing the leak. Cloudflare Pages serves `public/_headers` verbatim.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("_headers", () => {
  it("sets a Referrer-Policy that never leaks the query string cross-origin", () => {
    const path = fileURLToPath(new URL("../../public/_headers", import.meta.url));
    const contents = readFileSync(path, "utf8");
    expect(contents).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/);
    expect(contents).toMatch(/X-Content-Type-Options:\s*nosniff/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/vendor test:run src/lib/headers.test.ts`
Expected: FAIL — `public/_headers` does not exist.

- [ ] **Step 3: Write `public/_headers`**

```
/*
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
```

- [ ] **Step 4: Run the whole app suite + build**

Run: `bun run --cwd cire/vendor test:run && bun run --cwd cire/vendor build`
Expected: all tests PASS; build writes `dist/` including `_headers` copied from `public/`.

- [ ] **Step 5: Commit**

```bash
git add cire/vendor/public/_headers cire/vendor/src/lib/headers.test.ts
git commit -m "feat(cire/vendor): Referrer-Policy + security headers (S-L3)"
```

---

### Task 9: Deploy job (`deploy-cire-vendor`)

**Files:**
- Modify: `.github/workflows/deploy.yml` (add a new job after `deploy-cire-organiser`)

**Interfaces:** none.

> Mirrors `deploy-cire-organiser` exactly, changing only the working directory, project name, page title, and dropping `PUBLIC_CIRE_WEB_URL` (the portal has no invite-preview link). The `cire-vendor` Pages project must exist in the Cloudflare account before first run (documented in Task 10's runbook update).

- [ ] **Step 1: Read the existing `deploy-cire-organiser` job** (`.github/workflows/deploy.yml`, ~lines 205–250) to copy its exact structure (checkout, setup-bun, cache, install, build, deploy steps + `needs: build`, `environment: production`).

- [ ] **Step 2: Add the `deploy-cire-vendor` job** immediately after `deploy-cire-organiser`:

```yaml
  # The vendor self-service portal (vendor.cireweddings.com). PUBLIC_* vars bake
  # in at build time. The `cire-vendor` Pages project must exist in the account
  # before first run (create once: `wrangler pages project create cire-vendor`,
  # then add the custom domain vendor.cireweddings.com in the dashboard).
  deploy-cire-vendor:
    name: Deploy cire/vendor (Pages)
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

      - name: Build cire/vendor
        run: bun run --cwd cire/vendor build
        env:
          PUBLIC_CIRE_API_URL: https://api.cireweddings.com
          PUBLIC_OSN_ISSUER_URL: https://id.cireweddings.com
          PUBLIC_TURNSTILE_SITEKEY: ${{ vars.PUBLIC_TURNSTILE_SITEKEY }}

      - name: Deploy cire/vendor to Cloudflare Pages
        run: bunx wrangler pages deploy dist --project-name cire-vendor
        working-directory: cire/vendor
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 3: Validate the workflow YAML**

Run: `bunx --yes js-yaml .github/workflows/deploy.yml > /dev/null && echo OK` (or any YAML linter available in the repo). Expected: `OK` / no parse error. Confirm the new job is a sibling of `deploy-cire-organiser` (same indentation).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: deploy-cire-vendor Pages job"
```

---

### Task 10: Allowlist widening + changesets + docs

**Files:**
- Modify: `cire/api/wrangler.toml` (`WEB_ORIGIN`)
- Modify: `osn/api/wrangler.toml` (`OSN_ORIGIN`, `OSN_CORS_ORIGIN`)
- Create: `.changeset/<name>-cire-vendor-portal.md` (empty cire changeset)
- Create: `.changeset/<name>-osn-vendor-origin.md` (`@osn/api` patch)
- Modify: `cire/wiki/systems/vendors.md` (portal section)
- Modify: `cire/wiki/runbooks/production-deploy.md` (portal first-run + deploy steps)

**Interfaces:** none.

> **Why the allowlist widens both APIs:** the browser on `vendor.cireweddings.com` calls osn-api (`/organisations` create/list) AND cire-api (`/api/vendor/*`) cross-origin, so both must allow the new origin in CORS. RP_ID stays the apex (`cireweddings.com`) — passkeys are unaffected. This is intentional per the spec's security notes.

- [ ] **Step 1: Read the current origin values**

Run: `grep -n "WEB_ORIGIN" cire/api/wrangler.toml` and `grep -n "OSN_ORIGIN\|OSN_CORS_ORIGIN" osn/api/wrangler.toml`. Note the exact current comma-separated values (from PR #274: cire `WEB_ORIGIN = "https://invite.cireweddings.com,https://host.cireweddings.com"`; osn `OSN_ORIGIN`/`OSN_CORS_ORIGIN = "https://host.cireweddings.com"`).

- [ ] **Step 2: Append the vendor origin to `cire/api/wrangler.toml`**

Change `WEB_ORIGIN` to append `,https://vendor.cireweddings.com` (comma-separated, no spaces — match the existing format exactly). If there are multiple `[env.*]` blocks with their own `WEB_ORIGIN`, update every production-facing one consistently (check for `[env.staging]`/top-level).

- [ ] **Step 3: Append the vendor origin to `osn/api/wrangler.toml`**

Change both `OSN_ORIGIN` and `OSN_CORS_ORIGIN` to append `,https://vendor.cireweddings.com`. Keep `RP_ID` unchanged.

- [ ] **Step 4: Write the two changesets**

`.changeset/vendor-portal-cire.md` (empty — cire packages are unversioned):
```md
---
---

cire Vendors Slice 1 PR B: vendor self-service portal (vendor.cireweddings.com) — sign-in, OSN org create/pick, listing editor, invite-claim landing; deploy job + Referrer-Policy hardening. No cire package version bump (unversioned).
```

`.changeset/vendor-origin-osn.md` (`@osn/api` patch — CORS allowlist widened):
```md
---
"@osn/api": patch
---

Allow https://vendor.cireweddings.com in OSN_ORIGIN / OSN_CORS_ORIGIN so the new vendor portal can call the /organisations API cross-origin.
```

- [ ] **Step 5: Validate changesets**

Run: `bash scripts/validate-changesets.sh` (or the repo's changeset validation). Expected: pass — the empty cire changeset and the `@osn/api` patch are in SEPARATE files; no mixing of versioned + ignored packages.

- [ ] **Step 6: Update the docs**

In `cire/wiki/systems/vendors.md`, add a "Vendor portal (`cire/vendor`)" section: the app's screens, that it calls osn-api for orgs + cire-api for listings/claims via `authFetch`, and the claim-URL token-stripping + Referrer-Policy note.

In `cire/wiki/runbooks/production-deploy.md`, add a portal deploy subsection documenting the **manual first-run steps** (flagged, authorized separately at deploy time):
1. `wrangler pages project create cire-vendor` (once).
2. Add custom domain `vendor.cireweddings.com` to the `cire-vendor` Pages project (DNS CNAME on the `cireweddings.com` zone).
3. Confirm the cire-api `WEB_ORIGIN` + osn-api `OSN_ORIGIN`/`OSN_CORS_ORIGIN` redeploys carried the new origin (they ship with this PR's merge via the normal deploy jobs).
4. Note: no new secret required unless enabling Resend (`RESEND_API_KEY` was already covered in PR A).

- [ ] **Step 7: Run the impacted API config/tests** (guard against a malformed toml)

Run: `bun run --cwd cire/api test:run 2>/dev/null || true` and `bun run --cwd osn/api test:run 2>/dev/null || true` — primarily to confirm nothing imports/parses the wrangler files in a way the edit broke. (These are config-only edits; if the repo has no config test, a `bunx wrangler deploy --dry-run` per API is the check — but that may require secrets, so prefer a plain toml parse: `bunx --yes @iarna/toml-cli cire/api/wrangler.toml >/dev/null` if available, else visual diff.)

- [ ] **Step 8: Commit**

```bash
git add cire/api/wrangler.toml osn/api/wrangler.toml .changeset cire/wiki/systems/vendors.md cire/wiki/runbooks/production-deploy.md
git commit -m "feat(cire): allow vendor.cireweddings.com origin + portal docs + changesets"
```

---

## Post-plan: manual + deploy-time steps (NOT code — flagged for the human at merge)

These are surfaced in the PR body's "Decisions & issues" and require explicit user authorization at merge/deploy (do NOT perform them during implementation):

1. **Create the `cire-vendor` Cloudflare Pages project** (`wrangler pages project create cire-vendor`) before the first `deploy-cire-vendor` run, else the deploy job errors.
2. **Add the `vendor.cireweddings.com` custom domain / DNS** to the Pages project.
3. The **osn-api redeploy** (carrying the widened `OSN_ORIGIN`) and **cire-api redeploy** (widened `WEB_ORIGIN`) happen via the normal merge deploy — verify the new origin is live post-deploy (CORS preflight from the portal).
4. No new ARC re-registration is needed (PR A already granted `org:read`).

## Testing Summary

- `vendor-store.test.ts` — all data-layer helpers (org list/create, listing get/put, claim preview/consume), incl. 404/error paths.
- `SignInPanel.test.tsx` — renders sign-in + register switch.
- `OrgPicker.test.tsx` — list + pick + create.
- `ListingEditor.test.tsx` — load existing, save edits, empty-form for new org.
- `VendorApp.test.tsx` — auth-gated org-picker render (mocked `@osn/client/solid`).
- `ClaimApp.test.tsx` — preview + token-strip-from-URL.
- `headers.test.ts` — Referrer-Policy present.
- Whole-app: `bun run --cwd cire/vendor test:run` green + `bun run --cwd cire/vendor build` succeeds.

Then `/prep-pr` (parallel perf + security/EAA reviews + structured PR body) as the pre-merge gate.
