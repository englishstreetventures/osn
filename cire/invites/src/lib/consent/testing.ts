import type { ConsentCategory } from "./categories";
import { CONSENT_COOKIE_NAME, PREFIXED_CONSENT_COOKIE_NAME } from "./cookie";
import {
  type ConsentGrants,
  defaultGrants,
  encodeConsentRecord,
  makeConsentRecord,
} from "./record";
import { resetConsentStoreForTest } from "./store";

/**
 * Test helpers for the consent framework.
 *
 * Shipped as a normal module rather than inlined into each spec because three
 * separate suites (the gate, the banner, and every gated component) all need to
 * put the store into a known state, and a copy-pasted cookie-poke in each one
 * would quietly drift from the real encoding the moment the record shape
 * changes. These call the SAME `makeConsentRecord` / `encodeConsentRecord` the
 * production path uses, so a test that says "this guest consented" is asserting
 * against a record the application would actually have written — not a
 * hand-rolled approximation of one that might no longer parse.
 */

/**
 * Delete the consent cookie — both names, since a browser-tier test running
 * on https may have left the `__Host-` form set by a real `saveConsent` call —
 * and return the store to its pre-hydration state.
 */
export function resetConsentForTest(): void {
  if (typeof document !== "undefined") {
    document.cookie = `${CONSENT_COOKIE_NAME}=; Path=/; Max-Age=0`;
    document.cookie = `${PREFIXED_CONSENT_COOKIE_NAME}=; Path=/; Max-Age=0; Secure`;
  }
  resetConsentStoreForTest();
}

/**
 * Simulate a returning guest who already decided: write a real consent cookie
 * and reset the store so the next mount hydrates from it, exactly as a fresh
 * page load would.
 */
export function seedConsentForTest(granted: Partial<Record<ConsentCategory, boolean>>): void {
  const grants: ConsentGrants = { ...defaultGrants(), ...granted };
  const record = makeConsentRecord(grants, new Date("2026-07-29T00:00:00.000Z"));
  document.cookie = `${CONSENT_COOKIE_NAME}=${encodeConsentRecord(record)}; Path=/`;
  resetConsentStoreForTest();
}
