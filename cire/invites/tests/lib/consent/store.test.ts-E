import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSENT_COOKIE_NAME,
  PREFIXED_CONSENT_COOKIE_NAME,
  writeConsentToDocument,
} from "../../../src/lib/consent/cookie";
import {
  allGrants,
  defaultGrants,
  encodeConsentRecord,
  makeConsentRecord,
} from "../../../src/lib/consent/record";
import {
  acceptAllConsent,
  consentRecord,
  hydrateConsent,
  isCategoryGranted,
  needsConsentDecision,
  noteGatedContentLoaded,
  refreshConsentFromDocument,
  rejectAllConsent,
  saveConsent,
  setReloadPageForTest,
} from "../../../src/lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../../../src/lib/consent/testing";
import { onSecureOriginWithJar } from "../../test-support/secure-origin";

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

  it("reloads when the Pinterest switch goes from granted to revoked, after the board ran", () => {
    seedConsentForTest({ pinterest: true });
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), pinterest: false });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload on a FIRST-EVER refusal: no embed can have run before it", () => {
    // Third-party content is off until the guest allows it, so an undecided
    // guest's gates never rendered an embed and there is nothing to clear.
    resetConsentForTest();
    hydrateConsent();
    setReloadPageForTest(reload);

    rejectAllConsent();

    expect(reload).not.toHaveBeenCalled();
  });

  // The reload exists to tear down code that already ran, and on the COMMON
  // path none has. Both gated vendors mount only inside a click-opened details
  // sheet, while the prompt appears at once and holds the page until it is
  // answered — so a guest who presses "Reject all" has almost never
  // opened one, and reloading them would spend a whole document load, every
  // island's hydration and a re-fetch of the invite to clear nothing.
  it("does NOT reload when no gated content ever rendered this visit", () => {
    resetConsentForTest();
    hydrateConsent();
    setReloadPageForTest(reload);

    rejectAllConsent();

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload when the switch that ran is not the one revoked", () => {
    seedConsentForTest({ pinterest: true, maps: true });
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), pinterest: true, maps: false });

    expect(reload).not.toHaveBeenCalled();
  });

  // The Google Maps preview is a cross-origin iframe. Unmounting it destroys
  // that browsing context and everything running in it, so the unmount has
  // already cleared all a reload could — reloading would cost a full document
  // load for nothing.
  it("does NOT reload when only an iframe vendor (the map) rendered", () => {
    seedConsentForTest({ maps: true });
    hydrateConsent();
    noteGatedContentLoaded("maps", "google-maps");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), maps: false });

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when the map AND the Pinterest board rendered and both are revoked", () => {
    seedConsentForTest({ pinterest: true, maps: true });
    hydrateConsent();
    noteGatedContentLoaded("maps", "google-maps");
    noteGatedContentLoaded("pinterest", "pinterest");
    setReloadPageForTest(reload);

    saveConsent(defaultGrants());

    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The reload is keyed on the category the gate itself checks, because that
  // is the one whose revoke unmounts the embed — not the category the vendor
  // registry files it under.
  it("reloads on the gate's own category, even where the registry files the vendor elsewhere", () => {
    seedConsentForTest({ pinterest: true, maps: true });
    hydrateConsent();
    noteGatedContentLoaded("maps", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), pinterest: true, maps: false });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Only a gated vendor the registry knows can ask for a reload. An id the
  // registry cannot resolve, or an `"always"` vendor the switch never blocked,
  // does not.
  it("does NOT reload for a vendor id the registry does not know", () => {
    seedConsentForTest({ pinterest: true });
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "not-in-the-registry");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), pinterest: false });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload for an `always` vendor, even under a revoked category", () => {
    seedConsentForTest({ pinterest: true });
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "turnstile");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), pinterest: false });

    expect(reload).not.toHaveBeenCalled();
  });

  // The direction tests record the Pinterest board first, so the direction
  // check is the only thing between the save and a reload.
  it("does NOT reload on revoked → granted", () => {
    seedConsentForTest({ pinterest: false });
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), pinterest: true });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload on a no-op save", () => {
    seedConsentForTest({ pinterest: true });
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "pinterest");
    setReloadPageForTest(reload);

    saveConsent({ ...defaultGrants(), pinterest: true });

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload on a first-time grant (off → on, nothing was ever running)", () => {
    resetConsentForTest();
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "pinterest");
    setReloadPageForTest(reload);

    // Accept-all turns both switches on — an off → on move, not a revoke.
    acceptAllConsent();

    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload when the cookie write's read-back fails, even on a real revoke", () => {
    seedConsentForTest({ pinterest: true });
    hydrateConsent();
    // The board ran, so everything but the failed write says "reload".
    noteGatedContentLoaded("pinterest", "pinterest");
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
      saveConsent({ ...defaultGrants(), pinterest: false });
    } finally {
      if (originalCookieDescriptor) {
        Object.defineProperty(document, "cookie", originalCookieDescriptor);
      }
    }

    // The reload — which would have discarded the very refusal it was meant
    // to enforce, landing the guest back on the pre-decision defaults with no
    // record of having tried — must not fire.
    expect(reload).not.toHaveBeenCalled();
  });

  it("round-trips through allGrants() without reloading (accept-all is never a revoke)", () => {
    seedConsentForTest({ pinterest: false });
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "pinterest");
    setReloadPageForTest(reload);

    saveConsent(allGrants());

    expect(reload).not.toHaveBeenCalled();
  });
});

/**
 * A page the browser restores from its back/forward cache runs no hydration of
 * its own, so the store would keep the decision it read when the page was
 * first shown — "none", for a guest who then answered on the privacy notice
 * and came back.
 */
describe("refreshConsentFromDocument", () => {
  beforeEach(resetConsentForTest);
  afterEach(resetConsentForTest);

  it("picks up a decision written since the store was hydrated", () => {
    hydrateConsent();
    expect(needsConsentDecision()).toBe(true);

    writeConsentToDocument(makeConsentRecord(defaultGrants(), new Date()));
    refreshConsentFromDocument();

    expect(needsConsentDecision()).toBe(false);
    expect(consentRecord()?.grants.pinterest).toBe(false);
  });

  it("reloads when the restored page learns of a withdrawal after the Pinterest board ran", () => {
    // The guest accepted, opened a details sheet (the board's script ran in
    // this page), switched the moodboard off on the privacy notice and
    // pressed back. The unmount alone would leave Pinterest's code running.
    const reload = vi.fn();
    seedConsentForTest({ pinterest: true });
    hydrateConsent();
    noteGatedContentLoaded("pinterest", "pinterest");
    setReloadPageForTest(reload);

    writeConsentToDocument(makeConsentRecord(defaultGrants(), new Date()));
    refreshConsentFromDocument();

    expect(isCategoryGranted("pinterest")).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for a withdrawal when only the map ran, which its frame took with it", () => {
    const reload = vi.fn();
    seedConsentForTest({ maps: true });
    hydrateConsent();
    noteGatedContentLoaded("maps", "google-maps");
    setReloadPageForTest(reload);

    writeConsentToDocument(makeConsentRecord(defaultGrants(), new Date()));
    refreshConsentFromDocument();

    expect(isCategoryGranted("maps")).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("asks again when the stored decision has gone", () => {
    seedConsentForTest({ pinterest: false });
    hydrateConsent();
    expect(needsConsentDecision()).toBe(false);

    resetConsentCookieOnly();
    refreshConsentFromDocument();

    expect(needsConsentDecision()).toBe(true);
  });

  it("does nothing before the first hydration, which still holds the floor", () => {
    writeConsentToDocument(makeConsentRecord(allGrants(), new Date()));
    refreshConsentFromDocument();

    expect(consentRecord()).toBeNull();
    expect(needsConsentDecision()).toBe(false);
  });
});

/** Expire the consent cookie, both names, without touching the store. */
function resetConsentCookieOnly(): void {
  document.cookie = `${CONSENT_COOKIE_NAME}=; Path=/; Max-Age=0`;
  document.cookie = `${PREFIXED_CONSENT_COOKIE_NAME}=; Path=/; Max-Age=0; Secure`;
}

/**
 * On https the only consent cookie is the `__Host-` one. A bare `cire_consent`
 * there may have been planted by a sibling origin, and must neither decide for
 * the guest nor be carried over onto the `__Host-` name.
 */
describe("hydrateConsent on a secure origin", () => {
  beforeEach(resetConsentForTest);
  afterEach(resetConsentForTest);

  it("ignores a planted bare cookie, so the guest is still asked", () => {
    const planted = encodeConsentRecord(makeConsentRecord(allGrants(), new Date()));
    onSecureOriginWithJar(`${CONSENT_COOKIE_NAME}=${planted}`, (jar) => {
      hydrateConsent();

      expect(needsConsentDecision()).toBe(true);
      // Not promoted: the jar holds exactly what was planted.
      expect(jar()).toBe(`${CONSENT_COOKIE_NAME}=${planted}`);
    });
  });

  it("reads the guest's own __Host- cookie", () => {
    const own = encodeConsentRecord(makeConsentRecord(defaultGrants(), new Date()));
    onSecureOriginWithJar(`${PREFIXED_CONSENT_COOKIE_NAME}=${own}`, () => {
      hydrateConsent();

      expect(needsConsentDecision()).toBe(false);
      expect(isCategoryGranted("pinterest")).toBe(false);
    });
  });
});
