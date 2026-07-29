import { createSignal } from "solid-js";

import type { ConsentCategory } from "./categories";
import { readConsentFromDocument, writeConsentToDocument } from "./cookie";
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

/** Persist `grants` as the guest's decision and close the dialog. */
export function saveConsent(grants: ConsentGrants): void {
  const next = makeConsentRecord(normaliseGrants(grants), new Date());
  writeConsentToDocument(next);
  setRecord(next);
  setPreferencesOpen(false);
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

/**
 * Claim the right to render the preferences dialog. Returns an accessor that is
 * true only for the owning caller. Callers must invoke the returned `release`
 * on cleanup.
 */
export function claimConsentDialogHost(): { owns: () => boolean; release: () => void } {
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
 */
export function resetConsentStoreForTest(): void {
  setRecord(null);
  setHydrated(false);
  setPreferencesOpen(false);
  setDialogHostId(null);
}
