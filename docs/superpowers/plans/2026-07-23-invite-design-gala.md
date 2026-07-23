# Gala Invite Design Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship "Gala" — a second, structurally different invite design pack under the existing design selector, plus two headless extractions (claim-code, hero-backdrop) so classic and gala share behaviour without sharing markup.

**Architecture:** Gala is a full component tree at `cire/web/src/designs/gala/` (Document.astro, InviteHeader.tsx, InvitePage.tsx, UnlockReveal.motion.ts) registered in `designs/registry.ts` and selected server-side by `resolveDesignId`. Behaviour that must be identical across packs (claim-code submit/auto-claim, hero backdrop load lifecycle) moves to headless primitives in `cire/web/src/components/`. The catalog entry lives in `@shared/invite-designs`; a `?design=` SSR override enables organiser live preview without persisting.

**Tech Stack:** SolidJS islands in Astro, Motion v12, Tailwind v4, Vitest, `@cire/theme` palette system.

**Authoritative visual spec:** `docs/superpowers/specs/2026-07-23-invite-design-gala-design.md` (committed in this worktree). Tasks below reference its sections; where a task says "per spec §X", the spec text governs layout/classes/copy. Dials: VARIANCE 8 / MOTION 5 / DENSITY 3.

## Global Constraints

- Working directory (all commands): `/Users/ac/.work/osn.git/.claude/worktrees/feat+invite-design-gala` (branch `feat/invite-design-gala`, stacked on `feat/invite-design-selector`).
- NEVER import `effect` (Effect.ts) anywhere in `cire/web` or `cire/organiser`.
- Colours ONLY via existing tokens/CSS vars (`var(--invite-*)`, `sectionVars`, Tailwind token classes like `text-ink`, `bg-card`, `border-border`, `text-gilt`). No raw hex/oklch in components.
- Fonts locked: Cormorant Garamond (display) + Lato (body) — the existing loaded fonts. No new fonts.
- Every new `Document.astro` MUST include `<meta name="referrer" content="strict-origin-when-cross-origin" />` (finding S-L1).
- The `?code=` auto-claim handling MUST keep stripping the code from the URL (`url.searchParams.delete("code")` + `window.history.replaceState`) — it survives the claim-code extraction verbatim.
- Reduced motion: JS guards (`prefersReducedMotion()` matchMedia check) — Motion drives WAAPI which ignores CSS overrides. Every animation entry point keeps the guard.
- Motion v12: option is `ease` (NOT `easing`); `stagger(0.12, { startDelay: … })`; v12 reverts to base styles when an animation is GC'd — write end-states inline (`el.style.opacity = "1"` etc.) after/outside animations; wrap every `animate()` in try/catch + 1s timeout race; on failed dynamic motion import force-reveal (`eventsSection.style.opacity = "1"`).
- Mobile primary: verify 320 / 375 / 414 / 768 px. No horizontal scroll. No two-line buttons. Story image VISIBLE on mobile in gala (classic hides it).
- Changesets: exact package names `"@shared/invite-designs"`, `"@cire/web"`, `"@cire/organiser"`. NEVER mix version-less `@cire/*` with versioned packages in one changeset file — two separate files.
- Tests before claiming done: `bun run --cwd cire/web test` and `bun run --cwd cire/web build` (plus the package-local suites named per task). Shared package changes ⇒ full monorepo suite at the end.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Classic pack files may ONLY change where a task explicitly says so (consuming the extractions). Classic's rendered markup/classes must not change.

---

### Task 1: Add gala to the design catalog (+ fix the two gala-negative tests)

**Files:**
- Modify: `shared/invite-designs/src/index.ts`
- Modify: `shared/invite-designs/src/index.test.ts`
- Modify: `cire/web/src/designs/resolve.test.ts`

**Interfaces:**
- Produces: catalog entry `{ id: "gala", name: "Gala", tier: "free" }`; `DesignId` union becomes `"classic" | "gala"`. Later tasks (registry, organiser, api test) rely on `isDesignId("gala") === true`.

Two existing tests assert gala is UNKNOWN. They break the moment gala joins the catalog and must flip in the same commit.

- [ ] **Step 1: Update the failing assertions + add positive gala tests**

In `shared/invite-designs/src/index.test.ts`:
- In the test `rejects unknown ids and non-strings`, replace `expect(isDesignId("gala")).toBe(false);` with `expect(isDesignId("not-a-design")).toBe(false);` (keep the 42/null/undefined assertions).
- Add to the catalog describe block:

```ts
it("contains gala as a free design", () => {
  expect(DESIGNS).toContainEqual({ id: "gala", name: "Gala", tier: "free" });
});
```

In `cire/web/src/designs/resolve.test.ts`:
- In `falls back to classic for an unknown id`, replace `expect(resolveDesignId("gala")).toBe("classic");` with `expect(resolveDesignId("not-a-design")).toBe("classic");`
- Add:

```ts
it("accepts gala", () => {
  expect(resolveDesignId("gala")).toBe("gala");
});
```

- [ ] **Step 2: Run both suites to verify they fail**

Run: `bun run --cwd shared/invite-designs test:run` and `bun run --cwd cire/web test`
Expected: the new gala assertions FAIL (gala not in catalog yet). Note: `cire/web` test will ALSO fail typecheck-free at runtime only — vitest runs `resolve.test.ts` fine since `resolveDesignId` accepts `unknown`.

- [ ] **Step 3: Add gala to the catalog**

In `shared/invite-designs/src/index.ts` change the `DESIGNS` array to:

```ts
export const DESIGNS = [
  { id: "classic", name: "Classic", tier: "free" },
  { id: "gala", name: "Gala", tier: "free" },
] as const satisfies readonly DesignMeta[];
```

Update the doc comment's "Launch catalog is `classic` only" sentence to "Catalog: `classic` and `gala`, both free; the gate for `premium` tiers is built and tested but dormant." Update the `DesignId` doc comment to `(\`"classic" | "gala"\`)`.

NOTE: after this step `cire/web/src/designs/registry.ts` becomes a TYPE error (`Record<DesignId, DesignEntry>` missing `gala`). That is EXPECTED and resolved by Task 6. Do NOT run `bun run check` in this task; vitest and the shared package's own tests do not typecheck the registry (registry.ts imports .astro and is never vitest-imported).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd shared/invite-designs test:run` → PASS. `bun run --cwd cire/web test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/invite-designs/src cire/web/src/designs/resolve.test.ts
git commit -m "feat(invite-designs): add Gala to the design catalog"
```

---

### Task 2: Extract createClaimCode headless primitive

**Files:**
- Create: `cire/web/src/components/claim-code.ts`
- Create: `cire/web/src/components/claim-code.test.ts`
- Modify: `cire/web/src/components/LoginSection.tsx` (consume the primitive; rendered markup unchanged)

**Interfaces:**
- Produces (Task 5 gala InvitePage + classic LoginSection both consume):

```ts
import type { Accessor } from "solid-js";
import type { ClaimResult } from "./types";

export interface ClaimCodeOptions {
  apiUrl: string;
  /** Current claim result — non-null once claimed (suppresses ?code= auto-claim re-fire). */
  result: Accessor<ClaimResult | null>;
  onClaimed: (result: ClaimResult) => void;
}

export interface ClaimCode {
  code: Accessor<string>;
  setCode: (value: string) => void;
  loading: Accessor<boolean>;
  error: Accessor<string | null>;
  turnstileToken: Accessor<string | null>;
  setTurnstileToken: (token: string | null) => void;
  handleSubmit: (e: Event) => void;
}

export function createClaimCode(options: ClaimCodeOptions): ClaimCode;
```

- [ ] **Step 1: Write the failing test**

Create `cire/web/src/components/claim-code.test.ts`. Mirror the fetch-mocking + `createRoot` patterns already used in `cire/web/src/designs/classic/InvitePage.test.tsx` / the existing component tests (read them first). Required cases (each dispose()s its root):

1. `handleSubmit` POSTs `{apiUrl}/api/claim` with the code trimmed + uppercased in the JSON body, and calls `onClaimed` with the parsed payload when the response is ok and `isValidClaimResponse` passes.
2. Non-ok response sets `error()` to the invalid-code message currently shown by LoginSection (copy verbatim from LoginSection.tsx — do not invent new copy) and leaves `onClaimed` uncalled; `loading()` returns false after settle.
3. Rejected fetch (network error) sets the network-error message from LoginSection verbatim.
4. Empty/whitespace code: submit is a no-op (no fetch called).
5. `?code=ABC` in the URL on mount: auto-claims once AND strips `code` from the URL via `history.replaceState` (assert `window.location.search` no longer contains `code=`; jsdom supports replaceState). When `options.result()` is already non-null, the auto-claim does not fire.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd cire/web test`
Expected: FAIL — `claim-code.ts` module not found.

- [ ] **Step 3: Implement by MOVING code out of LoginSection**

Create `cire/web/src/components/claim-code.ts`. This is an extraction, not a rewrite: move the following members of `LoginSection.tsx` verbatim into `createClaimCode`, renaming `props.` → `options.` and `props.result` → `options.result()`:

- the `code` / `loading` / `error` / `turnstileToken` signals
- `submitCode(rawCode)` (uppercase publicId, turnstile-gate error "Please complete the verification challenge below." when `turnstileEnabled() && !turnstileToken()`, POST to `${options.apiUrl}/api/claim`, `isValidClaimResponse` check, error copy, `options.onClaimed(...)`)
- `handleSubmit`
- the `onMount` `?code=` block INCLUDING the S-L1 URL strip (`url.searchParams.delete("code")` + `window.history.replaceState(...)`) — byte-for-byte

Imports: `createSignal, onMount, type Accessor` from `solid-js`; `turnstileEnabled` from `./TurnstileWidget`; `type ClaimResult` from `./types`; `isValidClaimResponse` from `./utils`. Move the explanatory comments with the code. Return the `ClaimCode` object per the interface above.

Then refactor `LoginSection.tsx` to consume it:

```ts
const claim = createClaimCode({
  apiUrl: props.apiUrl,
  result: () => props.result,
  onClaimed: (result) => props.onClaimed(result),
});
```

Replace all uses of the removed locals with `claim.code()`, `claim.setCode`, `claim.loading()`, `claim.error()`, `claim.turnstileToken()`, `claim.setTurnstileToken`, `claim.handleSubmit`. Keep `turnstileEnabled` imported in LoginSection only if the JSX still references it (it does, for the submit-disabled check + widget Show). JSX/classes unchanged.

- [ ] **Step 4: Run the full cire/web suite**

Run: `bun run --cwd cire/web test`
Expected: PASS — new claim-code tests AND all existing LoginSection/InvitePage/InviteHeader/UnlockReveal tests (the regression net proving the extraction changed nothing).

- [ ] **Step 5: Commit**

```bash
git add cire/web/src/components/claim-code.ts cire/web/src/components/claim-code.test.ts cire/web/src/components/LoginSection.tsx
git commit -m "refactor(cire/web): extract headless createClaimCode from LoginSection"
```

---

### Task 3: Extract createHeroBackdrop headless primitive

**Files:**
- Create: `cire/web/src/components/hero-backdrop.ts`
- Create: `cire/web/src/components/hero-backdrop.test.ts`
- Modify: `cire/web/src/designs/classic/InviteHeader.tsx` (consume; rendered markup unchanged)

**Interfaces:**
- Produces (classic + gala InviteHeader both consume):

```ts
import type { Accessor } from "solid-js";

export type HeroBackdropState = "pending" | "loaded" | "error";

export interface HeroBackdrop {
  state: Accessor<HeroBackdropState>;
  /** Attach to the backdrop <img ref={…}> — powers the SSR already-loaded check. */
  setImgRef: (el: HTMLImageElement) => void;
  onLoad: () => void;
  onError: () => void;
}

export function createHeroBackdrop(src: Accessor<string | null>): HeroBackdrop;
```

- [ ] **Step 1: Write the failing test**

Create `cire/web/src/components/hero-backdrop.test.ts` using `createRoot` (+ `createSignal` for the src input). Cases:

```ts
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createHeroBackdrop } from "./hero-backdrop";

describe("createHeroBackdrop", () => {
  it("starts pending and transitions on load/error", () => {
    createRoot((dispose) => {
      const [src] = createSignal<string | null>("/img?variant=hero-bg");
      const hb = createHeroBackdrop(src);
      expect(hb.state()).toBe("pending");
      hb.onLoad();
      expect(hb.state()).toBe("loaded");
      hb.onError();
      expect(hb.state()).toBe("error");
      dispose();
    });
  });

  it("re-arms to pending only when the src actually changes", async () => {
    await createRoot(async (dispose) => {
      const [src, setSrc] = createSignal<string | null>("/a");
      const hb = createHeroBackdrop(src);
      hb.onLoad();
      setSrc("/a"); // same value — Solid won't re-run, state stays loaded
      expect(hb.state()).toBe("loaded");
      setSrc("/b");
      expect(hb.state()).toBe("pending");
      dispose();
    });
  });

  it("marks loaded on mount when the ref'd image already completed", () => {
    // jsdom images are never complete-with-naturalWidth; simulate via a stub object.
    createRoot((dispose) => {
      const [src] = createSignal<string | null>("/a");
      const hb = createHeroBackdrop(src);
      hb.setImgRef({ complete: true, naturalWidth: 100 } as HTMLImageElement);
      // onMount runs after createRoot body in Solid's microtask; flush:
      return Promise.resolve().then(() => {
        expect(hb.state()).toBe("loaded");
        dispose();
      });
    });
  });
});
```

Adjust the onMount-flush mechanics to match how the existing classic tests flush Solid lifecycles (read `cire/web/src/designs/classic/InviteHeader.test.tsx` first and reuse its helper approach if one exists).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd cire/web test` → FAIL, module not found.

- [ ] **Step 3: Implement**

Create `cire/web/src/components/hero-backdrop.ts` — this is classic InviteHeader's hero lifecycle (currently ~lines 130–205) moved verbatim, generalised over a `src` accessor. Complete implementation:

```ts
import { createEffect, createSignal, onMount, type Accessor } from "solid-js";

/**
 * Hero backdrop load lifecycle, shared by every design pack's header.
 * The image fades in on `loaded`; on `error` (a 404'd / unreachable image) the
 * pack DROPS it entirely so the gradient base layer shows through, instead of
 * leaving a permanently-invisible 0-opacity <img> pinned over the gradient.
 * `pending` keeps it at 0 opacity only until the first load/error resolves.
 */
export type HeroBackdropState = "pending" | "loaded" | "error";

export interface HeroBackdrop {
  state: Accessor<HeroBackdropState>;
  /** Attach to the backdrop <img ref={…}> — powers the SSR already-loaded check. */
  setImgRef: (el: HTMLImageElement) => void;
  onLoad: () => void;
  onError: () => void;
}

export function createHeroBackdrop(src: Accessor<string | null>): HeroBackdrop {
  const [state, setState] = createSignal<HeroBackdropState>("pending");

  // SSR-hydration fix: on an SSR page the browser starts loading the server-
  // rendered <img> during HTML parse, and its `load` event commonly fires
  // BEFORE the Solid island hydrates and attaches `onLoad` — so `onLoad` would
  // never run and the image stays at opacity 0 forever. Hold a ref and, on
  // mount, check `complete && naturalWidth > 0`: if the browser already
  // finished loading, mark it loaded immediately. `onLoad`/`onError` still
  // cover the not-yet-loaded path.
  let imgEl: HTMLImageElement | undefined;
  const revealIfAlreadyLoaded = () => {
    const el = imgEl;
    if (el && el.complete && el.naturalWidth > 0) setState("loaded");
  };
  onMount(revealIfAlreadyLoaded);

  // Re-arm the lifecycle ONLY when the resolved backdrop src actually changes
  // (a new upload or a variant flip). The on-mount no-store revalidation
  // returns the SAME url, so without this guard it would reset a shown image
  // back to `pending` (opacity 0) while the <img src> stays unchanged —
  // meaning the browser never re-fires `load`, leaving it stuck invisible.
  // On a genuine src change we reset to `pending`; the new src fires a fresh
  // `load`, and the ref-check also catches an already-cached new src.
  let prevSrc: string | null | undefined;
  createEffect(() => {
    const current = src();
    if (prevSrc === undefined) {
      // First run: adopt the SSR src without forcing pending (the onMount
      // ref check owns the already-loaded case).
      prevSrc = current;
      return;
    }
    if (current !== prevSrc) {
      prevSrc = current;
      setState("pending");
      // The new src may already be in the browser cache (so no `load`
      // fires); re-check the ref after the DOM updates.
      queueMicrotask(revealIfAlreadyLoaded);
    }
  });

  return {
    state,
    setImgRef: (el) => {
      imgEl = el;
    },
    onLoad: () => setState("loaded"),
    onError: () => setState("error"),
  };
}
```

Refactor `cire/web/src/designs/classic/InviteHeader.tsx`: delete the local `HeroState` type, `heroState` signal, `heroImgEl` ref, `revealIfAlreadyLoaded`, its `onMount`, and the `prevHeroSrc` effect (and the comments now living in the primitive). Replace with:

```ts
const heroBackdrop = createHeroBackdrop(heroBackdropSrc);
```

and in JSX: `heroState()` → `heroBackdrop.state()`, `ref={heroImgEl}`/ref-assignment → `ref={heroBackdrop.setImgRef}`, `onLoad={() => setHeroState("loaded")}` → `onLoad={heroBackdrop.onLoad}`, `onError={() => setHeroState("error")}` → `onError={heroBackdrop.onError}`. Rendered markup/classes unchanged.

- [ ] **Step 4: Run the full cire/web suite**

Run: `bun run --cwd cire/web test` → PASS (new tests + classic InviteHeader tests green).

- [ ] **Step 5: Commit**

```bash
git add cire/web/src/components/hero-backdrop.ts cire/web/src/components/hero-backdrop.test.ts cire/web/src/designs/classic/InviteHeader.tsx
git commit -m "refactor(cire/web): extract headless createHeroBackdrop from classic InviteHeader"
```

---

### Task 4: Gala InviteHeader (editorial hero + asymmetric story) + Document.astro

**Files:**
- Create: `cire/web/src/designs/gala/Document.astro`
- Create: `cire/web/src/designs/gala/InviteHeader.tsx`
- Create: `cire/web/src/designs/gala/InviteHeader.test.tsx`

**Interfaces:**
- Consumes: `createHeroBackdrop` (Task 3), `InviteDesignProps` / `InviteCustomisation` from `../types`, `sectionVars`/`applyPaletteToRoot`/`paletteRootVars`/`styleAttr` from the same modules classic uses, `variantSrc`/`HERO_BG_VARIANT`/crop helpers, `isHeroEmpty`/`isStoryEmpty` — same imports as classic's InviteHeader/Document (read them for exact paths).
- Produces: `gala/Document.astro` default export taking `InviteDesignProps` (registry consumes in Task 6); `gala/InviteHeader.tsx` default export with the same props shape as classic's InviteHeader (`{ apiUrl, slug, initial }`).

Authoritative layout: spec §"Gala hero" + §"Asymmetric story". Read the spec section AND classic's `Document.astro` + `InviteHeader.tsx` in full before writing. Behavioural parity requirements (non-negotiable):

1. Same data plumbing as classic: `initial` SSR prop, on-mount no-store revalidate fetch of `${apiUrl}/api/invite/${slug}` keeping painted values on failure, `applyPaletteToRoot` effect, `sectionVars(theme, "hero")` / `sectionVars(theme, "story")` tone application, `isHeroEmpty`/`isStoryEmpty` gates, crop handling via the same helpers.
2. Hero backdrop lifecycle via `createHeroBackdrop` (NOT a re-implementation).
3. `Document.astro`: copy classic's head verbatim (font preloads + noscript, S-L1 referrer meta, conditional hero image preload, `paletteStyle` on `<html>`) — only the body composition differs: gala InviteHeader island (`client:load`), gala InvitePage island (`client:visible`, same props as classic passes), `SiteFooter`.

Structural differences (per spec):
- Hero: LEFT-ALIGNED editorial block (max-width column, text anchored left/bottom on desktop, left on mobile) instead of classic's centered stack. Title still Cormorant Garamond via existing display classes; same scrim/backdrop tokens.
- Story: asymmetric two-column on md+ (image offset, overlapping the section boundary per spec), and on MOBILE the story image stays VISIBLE (stacked above the text) — classic's `hidden md:block` must NOT appear here. Image uses `max-w-full` inside a `minmax(0,1fr)` grid track — no horizontal overflow at 320px.

- [ ] **Step 1: Write failing tests** — `gala/InviteHeader.test.tsx` mirroring classic's `InviteHeader.test.tsx` setup (same render/flush helpers). Required cases: (a) renders hero title from `initial`; (b) hero hidden when `isHeroEmpty`; (c) story image is rendered WITHOUT a `hidden` class when `initial.story.imageUrl` set (assert the img/container class list does not contain `hidden`); (d) revalidate fetch called once on mount with `cache: "no-store"`; (e) failed revalidate keeps painted title.
- [ ] **Step 2: Run** `bun run --cwd cire/web test` → new file FAILS (module missing).
- [ ] **Step 3: Implement `gala/InviteHeader.tsx` + `gala/Document.astro`** per spec sections and parity list above.
- [ ] **Step 4: Run** `bun run --cwd cire/web test` → PASS.
- [ ] **Step 5: Commit** — `feat(cire/web): add Gala design hero + story header`

---

### Task 5: Gala InvitePage (claim panel object + 960px events) + UnlockReveal

**Files:**
- Create: `cire/web/src/designs/gala/InvitePage.tsx`
- Create: `cire/web/src/designs/gala/InvitePage.test.tsx`
- Create: `cire/web/src/designs/gala/UnlockReveal.motion.ts`
- Create: `cire/web/src/designs/gala/UnlockReveal.motion.test.ts`

**Interfaces:**
- Consumes: `createClaimCode` (Task 2) for the claim panel; `LoginSection` is NOT reused (gala renders its own claim panel markup per spec) — but `TurnstileWidget`, `EventCard`, `RsvpModal`, `DetailsModal`, `PulseAccountLink`/`AuthProvider`/`Toaster`, `sectionVars`, `applyPaletteToRoot` are the same shared components classic's InvitePage imports (read it; keep the same wiring, including the `Show when={!data().preview}` account-link gate and `import.meta.env.PUBLIC_TURNSTILE_SITEKEY` handling).
- Produces: default export `InvitePage` with classic's `InvitePageProps` shape (Document passes `apiUrl slug siteUrl theme details welcomeMessage`).

Parity requirements: same `createResource` no-store revalidate seeding from props; same `handleClaimed` flow — `setClaimResult` → microtask wait → dynamic `import("./UnlockReveal.motion")` → sequence(loginPanelRef, welcomeRef, eventsSectionRef) → catch sets `eventsSectionRef.style.opacity = "1"` (invite must never stay hidden); same RSVP/details modal wiring; same default eyebrow/heading copy constants.

Structural differences (per spec §"Claim panel" + §"Events column"):
- Claim panel: narrow bordered object (spec gives width/border/padding classes) — an artifact sitting on the page, not a full-bleed section. Uses `createClaimCode` for ALL behaviour; renders its own form markup + Turnstile widget + error line. Submit button text must fit one line at 320px.
- Events: column widened to `max-w-[960px]`, LEFT-aligned (`text-left`, no `mx-auto text-center` composition of classic) per spec; `data-event-card` attribute kept on each card wrapper (the motion stagger targets it).

`UnlockReveal.motion.ts`: start from classic's file (read it in full); keep `STEP_TIMEOUT_MS = 1000`, `prefersReducedMotion()` guard with `settleRevealed` early-return, `tryAnimate` timeout-race pattern, inline end-state writes, and the `[data-event-card]` stagger; adjust ONLY the choreography values the spec changes (MOTION dial 5 — spec §"Motion"). Test file mirrors classic's `UnlockReveal.motion.test.ts` (reduced-motion path settles instantly; sequence resolves; end states written inline).

- [ ] **Step 1: Write failing tests** — `InvitePage.test.tsx` mirroring classic's: (a) renders claim panel initially, events hidden; (b) after claim result, events section renders with `data-event-card` per event; (c) failed motion import still reveals events (opacity forced to "1"); (d) events container has `max-w-[960px]` class; plus the UnlockReveal test file.
- [ ] **Step 2: Run** `bun run --cwd cire/web test` → FAIL (modules missing).
- [ ] **Step 3: Implement** per spec + parity list.
- [ ] **Step 4: Run** `bun run --cwd cire/web test` → PASS.
- [ ] **Step 5: Commit** — `feat(cire/web): add Gala claim panel, events column and unlock reveal`

---

### Task 6: Register gala + `?design=` SSR preview override

**Files:**
- Modify: `cire/web/src/designs/registry.ts`
- Modify: `cire/web/src/pages/[slug].astro`

**Interfaces:**
- Consumes: `gala/Document.astro` (Task 4/5), `isDesignId` from `@shared/invite-designs`.

- [ ] **Step 1: Registry**

```ts
import GalaDocument from "./gala/Document.astro";
```
and add `gala: { Document: GalaDocument },` to the registry object. This also fixes the `Record<DesignId, …>` type error introduced in Task 1.

- [ ] **Step 2: `[slug].astro` override**

Replace the design resolution block with:

```astro
// Which design pack renders this wedding — resolved server-side off the same
// SSR fetch (zero extra round-trips, no client-side design switch, no flash).
// `?design=<id>` is an ORGANISER PREVIEW override: render this request in that
// design without persisting anything. Unknown override → the wedding's own
// design; unknown/missing stored id → classic.
const designOverride = Astro.url.searchParams.get('design')
const invite = result.kind === 'ok' ? result.invite : null
const designId = isDesignId(designOverride) ? designOverride : resolveDesignId(invite?.designId)
const { Document } = registry[designId]
```

with `import { isDesignId } from '@shared/invite-designs'` added.

- [ ] **Step 3: Verify build**

Run: `bun run --cwd cire/web test` → PASS. Run: `bun run --cwd cire/web build` → succeeds (this is the first task where the .astro graph including gala compiles).

- [ ] **Step 4: Commit** — `feat(cire/web): register Gala design and add ?design= SSR preview override`

---

### Task 7: cire-api — real-catalog PUT accepts gala

**Files:**
- Modify: `cire/api/src/routes/invite.test.ts`

The `PUT /invite/design (organiser)` describe uses a TEST-ONLY catalog (`test-free`/`test-premium`). Add ONE test against the REAL catalog (the default route construction used by the neighbouring `invite designId` describe at ~L1421) proving end-to-end that `gala` is now a valid persistable id: PUT `{ designId: "gala" }` as the owning organiser → 200, and the public invite GET surfaces `designId: "gala"`. Follow the setup pattern of the existing "persists a free design" test but WITHOUT the injected test catalog. Also verify no existing test in the file assumed the real catalog had exactly one entry (search for assertions on catalog length; fix by asserting containment, not length, if found).

- [ ] **Step 1: Write the failing test** (it fails only if wiring wrong — with Task 1 merged it should pass immediately; that's acceptable: it's a regression pin, run it red by temporarily… no — just add it and run).
- [ ] **Step 2: Run** `bun run --cwd cire/api test:run` → PASS (all).
- [ ] **Step 3: Commit** — `test(cire/api): pin design PUT accepting gala from the real catalog`

---

### Task 8: Organiser selector — thumbnails, live preview link, roving tabindex

**Files:**
- Modify: `cire/organiser/src/components/InviteBuilder.tsx` (design selector section)
- Modify: `cire/organiser/src/components/InviteBuilder.test.tsx`

Read the current design-selector block in `InviteBuilder.tsx` and its `design selector` describe in the test file first; extend, don't rewrite. Spec §"Organiser selector". Three additions:

1. **SVG thumbnails**: each design card gets an abstract inline SVG (~120×84 viewBox, `stroke="currentColor"`/`fill="currentColor"` only — NO raw colours) sketching the pack's structure: classic = centered stack (three centered horizontal lines + centered block), gala = left-anchored lines + offset image block. Decorative: `aria-hidden="true"`.
2. **"Preview live" link** rendered OUTSIDE the radio control (so clicking it never toggles selection): `<a target="_blank" rel="noopener">` to the wedding's public invite URL with `?design=<id>` appended (reuse however InviteBuilder already builds the guest link; append with `&` when a query already exists). Visible on every unlocked card.
3. **Keyboard**: roving tabindex across the design radio group — only the active card is tabbable; ArrowRight/ArrowDown next, ArrowLeft/ArrowUp previous, Home/End first/last; navigation SKIPS locked (premium, unentitled) cards; moving focus selects (radio semantics) via the existing save path.

New test cases (extend the existing describe):
- renders a thumbnail SVG per card (`aria-hidden`)
- preview link per unlocked card with `target="_blank"`, `rel="noopener"`, href containing `design=gala` on the gala card; clicking it does NOT trigger a save PUT
- ArrowRight from classic selects gala (PUT `{ designId: "gala" }`); Home/End jump; locked card skipped (use the existing test-catalog fixtures with a premium design between two free ones)
- exactly one card has `tabindex="0"` at a time

- [ ] **Step 1: Write failing tests** → **Step 2: Run** `bun run --cwd cire/organiser test` → FAIL → **Step 3: Implement** → **Step 4: Run** → PASS → **Step 5: Commit** — `feat(cire/organiser): design thumbnails, live preview links and keyboard nav`

---

### Task 9: Changesets + wiki

**Files:**
- Create: `.changeset/gala-design-catalog.md`
- Create: `.changeset/gala-design-pack.md`
- Modify: `cire/wiki/todo/web.md`

- [ ] **Step 1: Two changesets (NEVER one file — validate-changesets.sh enforces the split)**

`.changeset/gala-design-catalog.md`:
```markdown
---
"@shared/invite-designs": minor
---

Add the Gala design to the invite design catalog.
```

`.changeset/gala-design-pack.md`:
```markdown
---
"@cire/web": patch
"@cire/organiser": patch
---

Gala invite design pack: editorial left-aligned hero, mobile-visible asymmetric story, bordered claim panel, 960px left-aligned events column; organiser selector gains thumbnails, live-preview links and keyboard navigation; `?design=` SSR preview override.
```

- [ ] **Step 2: Verify** `bash scripts/validate-changesets.sh` → PASS.
- [ ] **Step 3: Wiki** — in `cire/wiki/todo/web.md`: close/annotate the layout-restructure note (the gala pack delivers it), bump frontmatter `last-reviewed: 2026-07-23`.
- [ ] **Step 4: Commit** — `chore: changesets + wiki for Gala design pack`

---

### Task 10: Full verification (controller-run)

- [ ] `bun run --cwd cire/web test` + `bun run --cwd cire/web build`
- [ ] `bun run --cwd cire/organiser test` (+ build)
- [ ] `bun run test` (full monorepo — shared package changed)
- [ ] Headless Chrome screenshots of the gala page (`?design=gala` on local dev) at 320/375/414/768 px: story image visible at 320, no horizontal scroll, no two-line buttons
- [ ] Findings (if any) recorded in `cire/wiki/todo/web.md` / `perf.md` with `last-reviewed` bumped
