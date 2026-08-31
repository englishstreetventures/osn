import { createSignal } from "solid-js";

import { CONSENT_CATEGORIES, type ConsentCategory } from "./categories";
import {
  migrateBareConsentCookie,
  readConsentFromDocument,
  writeConsentToDocumentAndVerify,
} from "./cookie";
import {
  allGrants,
  type ConsentGrants,
  type ConsentRecord,
  defaultGrants,
  isGranted,
  makeConsentRecord,
  normaliseGrants,
  preDecisionGrants,
} from "./record";
import { gatedVendorsInCategory } from "./vendors";

/**
 * The shared, page-wide consent state.
 *
 * Module-level signals rather than a Solid context, on purpose. The guest site
 * is a set of independent Astro islands — the invite page, the header, and (in
 * future) a banner mounted straight into the document shell are separate
 * hydration roots with no common Solid parent, so there is no single tree a
 * provider could sit at the top of. A module singleton is the thing every
 * island genuinely shares. It also preserves the one behaviour the old
 * Pinterest gate got right: granting consent in one place flips every gated
 * embed on the page in the same tick, with no plumbing.
 *
 * ## Hydration rule
 *
 * `record()` starts `null` (= "no decision") and is only populated in
 * {@link hydrateConsent}, which callers run from `onMount`. That is what keeps
 * the server-rendered markup and the first client render identical: both sit at
 * the required-only floor, and third-party content appears a tick later once
 * the cookie has been read. Seeding the signal at module scope instead would
 * produce different HTML on server and client and risk Solid mis-patching the
 * hydrated tree.
 *
 * Note the floor — not the opt-out defaults — is what applies during that tick,
 * even though optional categories are on by default. `record() === null` means
 * two different things depending on whether hydration has run ("we haven't
 * looked yet" vs "we looked, and there's nothing"), and only the second may
 * resolve to the permissive defaults. {@link isCategoryGranted} is where that
 * distinction is enforced.
 */

const [record, setRecord] = createSignal<ConsentRecord | null>(null);
const [hydrated, setHydrated] = createSignal(false);
const [preferencesOpen, setPreferencesOpen] = createSignal(false);

/**
 * The bespoke key the Pinterest-only gate used before this framework existed.
 *
 * It is deleted on hydration, NOT migrated into a grant. A guest who once
 * clicked "Load Pinterest content" consented to Pinterest specifically; the
 * `embeds` category now also covers the Google Maps venue embed, so importing
 * that click would silently widen a narrow consent into a broader one the guest
 * was never shown. Those guests are asked once more instead — the honest cost
 * of consolidating the gates, and the reason `CONSENT_POLICY_VERSION` exists.
 */
const LEGACY_PINTEREST_KEY = "cire:pinterest-consent";

function clearLegacyPinterestConsent(): void {
  try {
    localStorage.removeItem(LEGACY_PINTEREST_KEY);
  } catch {
    // Storage disabled — nothing to clean up.
  }
}

/**
 * Read the persisted decision into the store. Idempotent and safe to call from
 * every island that needs consent, so a gate works on a page whose banner
 * hasn't mounted (or was never placed).
 */
export function hydrateConsent(): void {
  if (hydrated()) return;
  clearLegacyPinterestConsent();
  // Move an already-decided guest onto the `__Host-` name before reading. It
  // has to happen here, on the read path, because the write path never runs
  // again for them: their stored choice reads back fine, so the banner stays
  // away and nothing would ever perform the secure write the fix for
  // osn-tracker#163 depends on. See `migrateBareConsentCookie`.
  migrateBareConsentCookie();
  setRecord(readConsentFromDocument());
  setHydrated(true);
}

/** The stored decision, or `null` if the guest hasn't made one. */
export const consentRecord = record;

/** Has the persisted decision been read yet? Gates the banner's first paint. */
export const consentHydrated = hydrated;

/**
 * Is `category` granted right now?
 *
 * Before hydration this is the FLOOR (required only) — not the opt-out
 * defaults. The optional categories are on by default for a guest who hasn't
 * decided, but we do not know whether this guest is that guest until the cookie
 * has been read: they may have refused. Holding at the floor for that one tick
 * is what stops a refusal being briefly ignored on every page load. After
 * hydration, a `null` record resolves through `isGranted` to
 * {@link preDecisionGrants}.
 */
export function isCategoryGranted(category: ConsentCategory): boolean {
  if (!hydrated()) return defaultGrants()[category];
  return isGranted(record(), category);
}

/**
 * Should the first-layer banner be shown? Only once we've actually read the
 * cookie and found no decision — otherwise a returning guest who already chose
 * would see the banner flash on every page load.
 */
export function needsConsentDecision(): boolean {
  return hydrated() && record() === null;
}

/** Is the preferences dialog open? */
export const consentPreferencesOpen = preferencesOpen;

export function openConsentPreferences(): void {
  setPreferencesOpen(true);
}

export function closeConsentPreferences(): void {
  setPreferencesOpen(false);
}

/**
 * The reload triggered by a granted → revoked transition (see
 * {@link saveConsent}). A module-level reference rather than a direct
 * `location.reload()` call, so a test can substitute a spy in place of it. The
 * alternative — stubbing out the global `location` object — breaks every other
 * jsdom test in the same file that happens to touch `location` or navigation,
 * because jsdom exposes exactly one `window.location` per test document; a
 * narrow, purpose-built seam avoids that.
 */
function defaultReloadPage(): void {
  location.reload();
}

/** See `resetConsentStoreForTest`'s doc for why the test default is this, not {@link defaultReloadPage}. */
function noopReloadPageForTest(): void {
  // Intentionally does nothing.
}

let reloadPage: () => void = defaultReloadPage;

/** Test-only: substitute {@link reloadPage}. Reset by `resetConsentStoreForTest`. */
export function setReloadPageForTest(fn: () => void): void {
  reloadPage = fn;
}

/**
 * Does moving from `previous` to `next` revoke a category that governs at
 * least one `"gated"` vendor?
 *
 * Category-level, not vendor-level, because a category is the unit the toggle
 * actually grants or revokes. Only `"gated"` vendors count: an `"always"`
 * vendor was never blocked by this category's switch, so revoking the category
 * changes nothing that vendor is doing.
 */
function revokesGatedCategory(previous: ConsentGrants, next: ConsentGrants): boolean {
  return CONSENT_CATEGORIES.some(
    (category) =>
      previous[category] &&
      !next[category] &&
      gatedVendorsInCategory(category).length > 0 &&
      loadedGatedCategories.has(category),
  );
}

/**
 * Categories whose gated content actually rendered during this visit.
 *
 * The reload exists to tear down third-party code that already ran. If none
 * ever ran, there is nothing to tear down and the reload is pure cost — and
 * that is the COMMON path, not the rare one: both gated vendors (the Pinterest
 * board and the Google Maps preview) mount only inside a click-opened event
 * details sheet, while the banner appears immediately, so a guest who lands and
 * presses "Reject all" has almost never opened one. Reloading them would spend
 * a full document load, every island's hydration and a re-fetch of the invite
 * to clear nothing at all.
 *
 * A plain module-level `Set`, not a signal: nothing renders from it, it only
 * has to be readable at save time, and a signal would invalidate the store's
 * subscribers on every gate mount for no benefit. It resets on reload, which is
 * exactly right — a reload is what clears the thing it tracks.
 */
const loadedGatedCategories = new Set<ConsentCategory>();

/**
 * Record that a gated vendor's content rendered. Called by `ConsentGate` when
 * it actually renders children for a `"gated"` vendor — not when it renders the
 * placeholder, which runs no third-party code.
 */
export function noteGatedContentLoaded(category: ConsentCategory): void {
  loadedGatedCategories.add(category);
}

/**
 * Persist `grants` as the guest's decision and close the dialog.
 *
 * CON-S-M1: switching a gated category off unmounts its embeds (see
 * `ConsentGate`), but that only stops FURTHER requests — a vendor's script
 * that already ran (globals it set, listeners it attached, its own storage) is
 * still live in the page for the rest of the visit. Under the opt-out defaults
 * this is the common case, not an edge one: the banner appears after the
 * gated embeds have already loaded, so "Reject all" is nearly always clicked
 * with a third-party context already running.
 *
 * The only clean teardown is a reload, and it is gated on two conditions, both
 * load-bearing:
 *
 *  1. Granted → revoked ONLY. Not revoked → granted (nothing to tear down),
 *     not a no-op save (nothing changed), not a first-time grant (nothing was
 *     ever running to begin with).
 *  2. The cookie write must have actually SUCCEEDED, checked by reading it
 *     back ({@link writeConsentToDocumentAndVerify}) rather than trusting that
 *     the write call merely returned — it swallows failures by design. A
 *     reload on an unpersisted refusal would throw the choice away on the very
 *     reload meant to enforce it, which is worse than the bug being fixed:
 *     the guest would watch the page reload believing they had just refused,
 *     and land back on the opt-out defaults with no record of having tried.
 */
export function saveConsent(grants: ConsentGrants): void {
  const previous = currentGrants();
  const next = makeConsentRecord(normaliseGrants(grants), new Date());
  const written = writeConsentToDocumentAndVerify(next);
  setRecord(next);
  setPreferencesOpen(false);

  if (written && revokesGatedCategory(previous, next.grants)) {
    reloadPage();
  }
}

/** "Accept all" — every category on. */
export function acceptAllConsent(): void {
  saveConsent(allGrants());
}

/**
 * "Reject all" — required categories only. Note this still writes a record:
 * refusing is a decision, and persisting it is what stops us asking again. A
 * banner that reappeared after a refusal would be nagging the guest into
 * consent, which is the behaviour the "reject must be as easy as accept" rule
 * exists to prevent.
 */
export function rejectAllConsent(): void {
  saveConsent(defaultGrants());
}

/**
 * The grants to seed the preferences dialog's toggles with: the guest's stored
 * choice if they have one, the opt-out defaults if they don't.
 *
 * Seeding an undecided guest's dialog from {@link preDecisionGrants} rather
 * than the floor is what makes the toggles TRUE — they show what is actually
 * loading right now, which is the only reading of a checkbox that isn't
 * misleading. A dialog that showed `embeds` unticked while the map was on
 * screen would be describing a state the site is not in.
 */
export function currentGrants(): ConsentGrants {
  return record()?.grants ?? preDecisionGrants();
}

/**
 * Grant a single category, leaving the others as they are. This is what the
 * in-place "allow this content" button on a blocked embed calls.
 *
 * Consent is granted at CATEGORY granularity even from a vendor-specific
 * placeholder, because the category is the unit the guest was shown and the
 * unit the preferences dialog can later withdraw. A hidden per-vendor grant
 * would not appear in that dialog, leaving the guest with a permission they
 * could see the effects of but not revoke — so the placeholder copy names the
 * category ("third-party content"), not just the vendor that prompted it.
 */
export function grantCategory(category: ConsentCategory): void {
  saveConsent({ ...currentGrants(), [category]: true });
}

/**
 * Dialog-host arbitration.
 *
 * More than one component can offer a route into the preferences dialog — the
 * banner, the footer's standing "privacy choices" link, the button on a blocked
 * embed — and each of them needs the dialog to appear when its own page has no
 * banner. If each simply rendered the dialog, a page carrying two of them would
 * open two stacked copies with two independent drafts, and whichever was saved
 * last would silently win.
 *
 * So exactly one mounted component owns the rendering: the first to claim it.
 * The claim is released on unmount and can be re-claimed, so an island that
 * mounts later still gets a working dialog once the first one goes away.
 */
const [dialogHostId, setDialogHostId] = createSignal<number | null>(null);
let nextDialogHostId = 0;

/** What {@link claimConsentDialogHost} hands back to the claiming component. */
export interface ConsentDialogHostClaim {
  /** True only for the component that currently owns the dialog. */
  owns: () => boolean;
  /** Release the claim on unmount, so a later island can take it. */
  release: () => void;
}

/**
 * Claim the right to render the preferences dialog. Returns an accessor that is
 * true only for the owning caller. Callers must invoke the returned `release`
 * on cleanup.
 */
export function claimConsentDialogHost(): ConsentDialogHostClaim {
  const id = ++nextDialogHostId;
  if (dialogHostId() === null) setDialogHostId(id);

  return {
    owns: () => dialogHostId() === id,
    release: () => {
      if (dialogHostId() === id) setDialogHostId(null);
    },
  };
}

/**
 * Test-only: return the store to its pre-hydration state. Lets a test simulate
 * a fresh page load after seeding or clearing `document.cookie`, without a real
 * reload (the module is evaluated once per test file).
 *
 * Also returns {@link reloadPage} to a no-op, NOT {@link defaultReloadPage}.
 * `location.reload()` is unimplemented in jsdom and logs a "Not implemented:
 * navigation" warning on every call, so a gate/banner test that happens to
 * drive a real granted → revoked save (most of them do, incidentally, when
 * asserting teardown) would otherwise spam that warning for a reload it never
 * asked about. A test that means to assert the reload itself calls
 * {@link setReloadPageForTest} with its own spy after this runs, same as any
 * other test-only default here.
 */
export function resetConsentStoreForTest(): void {
  setRecord(null);
  setHydrated(false);
  setPreferencesOpen(false);
  setDialogHostId(null);
  reloadPage = noopReloadPageForTest;
  loadedGatedCategories.clear();
}
