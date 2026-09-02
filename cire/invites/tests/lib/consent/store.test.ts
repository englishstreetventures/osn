import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSENT_COOKIE_NAME } from "../../../src/lib/consent/cookie";
import { allGrants, defaultGrants } from "../../../src/lib/consent/record";
import {
  acceptAllConsent,
  hydrateConsent,
  noteGatedContentLoaded,
  rejectAllConsent,
  saveConsent,
  setReloadPageForTest,
} from "../../../src/lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../../../src/lib/consent/testing";

/**
 * CON-S-M1 (osn-tracker#162): `saveConsent` reloads the page on a
 * granted → revoked transition for a category that governs at least one
 * `"gated"` vendor — the only way to tear down a third party's already-run
 * side effects, not just stop it loading further. These tests pin the two
 * conditions that gate the reload (see `saveConsent`'s doc in `store.ts`):
 * the transition direction, and a successful cookie write.
 *
 * `location.reload()` itself is not callable in jsdom, so `reloadPage` is
 * substituted with a spy via `setReloadPageForTest` rather than stubbing
 * `window.location` — the module-level indirection `store.ts` defines for
 * exactly this.
 */
describe("saveConsent — reload on granted → revoked (osn-tracker#162)", () => {
  const reload = vi.fn();

  beforeEach(() => {
    resetConsentForTest();
    reload.mockClear();
  });

  afterEach(() => {
    resetConsentForTest();
  });

  it("reloads when a gated category (embeds) goes from granted to revoked, after its content ran", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    noteGatedContentLoaded("embeds");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: false });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads on the FIRST-EVER decision, when the embeds already ran", () => {
    // A guest who opened an event's details sheet — mounting the moodboard or
    // the map under the opt-out default — and only then pressed "Reject all".
    // Third-party code really did run, so there really is something to clear.
    resetConsentForTest();
    hydrateConsent();
    noteGatedContentLoaded("embeds");
    setReloadPageForTest(reload);

    rejectAllConsent();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  // P-W1 (found reviewing this branch): the reload exists to tear down code
  // that already ran, and on the COMMON path none has. Both gated vendors
  // mount only inside a click-opened details sheet, while the banner appears
  // immediately — so a guest who lands and presses "Reject all" has almost
  // never opened one, and reloading them would spend a whole document load,
  // every island's hydration and a re-fetch of the invite to clear nothing.
  it("does NOT reload when no gated content ever rendered this visit", () => {
    resetConsentForTest();
    hydrateConsent();
    setReloadPageForTest(reload);

    rejectAllConsent();

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload when the category that ran is not the one revoked", () => {
    seedConsentForTest({ embeds: true, analytics: true });
    hydrateConsent();
    noteGatedContentLoaded("embeds");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: true });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload on revoked → granted", () => {
    seedConsentForTest({ embeds: false });
    hydrateConsent();
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: true });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload on a no-op save", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: true });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload on a first-time grant (off → on, nothing was ever running)", () => {
    resetConsentForTest();
    hydrateConsent();
    setReloadPageForTest(reload);

    // Accept-all only turns `analytics` on for real (the other opt-out
    // categories are already granted pre-decision) — an off → on move, not a
    // revoke.
    acceptAllConsent();

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload for a revoked category with no gated vendors (functional)", () => {
    seedConsentForTest({ functional: true });
    hydrateConsent();
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), functional: false });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload when the cookie write's read-back fails, even on a real revoke", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    setReloadPageForTest(reload);

    // Simulate a blocked write: `document.cookie` accepts nothing, so the
    // read-back inside `writeConsentToDocumentAndVerify` can never show the
    // new value.
    const originalCookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => `${CONSENT_COOKIE_NAME}=stale`,
      set: () => {
        // Nothing lands.
      },
    });

    try {
      saveConsent({ ...defaultGrants(), embeds: false });
    } finally {
      if (originalCookieDescriptor) {
        Object.defineProperty(document, "cookie", originalCookieDescriptor);
      }
    }

    // The reload — which would have discarded the very refusal it was meant
    // to enforce, landing the guest back on the opt-out defaults with no
    // record of having tried — must not fire.
    expect(reload).not.toHaveBeenCalled();
  });

  it("round-trips through allGrants() without reloading (accept-all is never a revoke)", () => {
    seedConsentForTest({ embeds: false });
    hydrateConsent();
    setReloadPageForTest(reload);

    saveConsent(allGrants());

    expect(reload).not.toHaveBeenCalled();
  });
});
