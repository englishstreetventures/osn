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
 * `saveConsent` reloads the page on a granted → revoked transition when a
 * gated vendor whose code runs in the page itself rendered under the revoked
 * category. Unmounting the embed removes its DOM and `<script>`, but the
 * globals, listeners and timers that code set up stay live in the page's
 * JavaScript realm — only a reload stops them. A vendor that runs only inside
 * its own iframe is torn down whole by the unmount, so it never needs one.
 * These tests pin the conditions that gate the reload (see `saveConsent`'s doc
 * in `store.ts`): the transition direction, which vendor rendered under which
 * category, and a successful cookie write.
 *
 * `location.reload()` itself is not callable in jsdom, so `reloadPage` is
 * substituted with a spy via `setReloadPageForTest` rather than stubbing
 * `window.location` — the module-level indirection `store.ts` defines for
 * exactly this.
 */
describe("saveConsent — reload on granted → revoked", () => {
  const reload = vi.fn();

  beforeEach(() => {
    resetConsentForTest();
    reload.mockClear();
  });

  afterEach(() => {
    resetConsentForTest();
  });

  it("reloads when embeds goes from granted to revoked, after the Pinterest board ran", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    noteGatedContentLoaded("embeds", "pinterest");
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
    noteGatedContentLoaded("embeds", "pinterest");
    setReloadPageForTest(reload);

    rejectAllConsent();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The reload exists to tear down code that already ran, and on the COMMON
  // path none has. Both gated vendors mount only inside a click-opened details
  // sheet, while the banner appears immediately — so a guest who lands and
  // presses "Reject all" has almost never opened one, and reloading them would
  // spend a whole document load, every island's hydration and a re-fetch of
  // the invite to clear nothing.
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
    noteGatedContentLoaded("embeds", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: true });

    expect(reload).not.toHaveBeenCalled();
  });

  // The Google Maps preview is a cross-origin iframe. Unmounting it destroys
  // that browsing context and everything running in it, so the unmount has
  // already cleared all a reload could — reloading would cost a full document
  // load for nothing.
  it("does NOT reload when only an iframe vendor (the map) rendered", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    noteGatedContentLoaded("embeds", "google-maps");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: false });

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when the map AND the Pinterest board rendered", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    noteGatedContentLoaded("embeds", "google-maps");
    noteGatedContentLoaded("embeds", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: false });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The reload is keyed on the category the gate itself checks, because that
  // is the one whose revoke unmounts the embed — not the category the vendor
  // registry files it under.
  it("reloads on the gate's own category, even where the registry files the vendor elsewhere", () => {
    seedConsentForTest({ embeds: true, analytics: true });
    hydrateConsent();
    noteGatedContentLoaded("analytics", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: true, analytics: false });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Only a gated vendor the registry knows can ask for a reload. An id the
  // registry cannot resolve, or an `"always"` vendor the switch never blocked,
  // does not.
  it("does NOT reload for a vendor id the registry does not know", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    noteGatedContentLoaded("embeds", "not-in-the-registry");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: false });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload for an `always` vendor, even under a revoked category", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    noteGatedContentLoaded("embeds", "turnstile");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: false });

    expect(reload).not.toHaveBeenCalled();
  });

  // The direction tests record the Pinterest board first, so the direction
  // check is the only thing between the save and a reload.
  it("does NOT reload on revoked → granted", () => {
    seedConsentForTest({ embeds: false });
    hydrateConsent();
    noteGatedContentLoaded("embeds", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: true });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload on a no-op save", () => {
    seedConsentForTest({ embeds: true });
    hydrateConsent();
    noteGatedContentLoaded("embeds", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), embeds: true });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload on a first-time grant (off → on, nothing was ever running)", () => {
    resetConsentForTest();
    hydrateConsent();
    noteGatedContentLoaded("analytics", "pinterest");
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
    // The board ran, so everything but the failed write says "reload".
    noteGatedContentLoaded("embeds", "pinterest");
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
    noteGatedContentLoaded("embeds", "pinterest");
    setReloadPageForTest(reload);

    saveConsent(allGrants());

    expect(reload).not.toHaveBeenCalled();
  });
});
