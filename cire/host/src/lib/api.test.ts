// @vitest-environment happy-dom
import { AuthExpiredError } from "@shared/rp-auth";
import { afterEach, describe, expect, it } from "vitest";

import { apiUrl, isAuthExpired, redirectToLogin } from "./api";

/**
 * `isAuthExpired` decides between "bounce the organiser to sign-in" and "show
 * an error", so both misclassifications are user-visible: a false negative
 * leaves a dead dashboard behind an expired cookie, a false positive throws
 * someone out of a task mid-edit. The string-match arm is the fragile one —
 * these pin the shapes it must and must not accept.
 */
describe("isAuthExpired", () => {
  it("accepts the real error", () => {
    expect(isAuthExpired(new AuthExpiredError())).toBe(true);
  });

  it("accepts a structurally-equal error from another copy of the package", () => {
    // Two versions of @shared/rp-auth in one tree defeat `instanceof`; the
    // `_tag` discriminant is what survives that.
    expect(isAuthExpired({ _tag: "AuthExpiredError" })).toBe(true);
  });

  it("accepts an Effect FiberFailure printout", () => {
    // Effect wraps a failure before it reaches a plain `catch`, so neither
    // `instanceof` nor an own `_tag` survives — only the printout does. The
    // shape is Effect's real one, verified against a live FiberFailure in
    // `osn/client/tests/errors.test.ts`: the tag heads the string.
    const wrapped = {
      toString: () => "(FiberFailure) AuthExpiredError: Your session has expired.",
    };
    expect(isAuthExpired(wrapped)).toBe(true);
  });

  // S-L2: the printout arm is anchored, so a message that merely QUOTES the
  // tag is not an expiry. `EnquiryApiError.message` is the server's `error`
  // code verbatim — an unanchored match would hand a sign-out decision to
  // whatever string the API returned.
  it("rejects an error that merely quotes the tag in its message", () => {
    const echoed = new Error("EnquiryApiError: AuthExpiredError");
    expect(isAuthExpired(echoed)).toBe(false);
  });

  it("rejects an unrelated failure", () => {
    expect(isAuthExpired(new Error("Network request failed"))).toBe(false);
    expect(isAuthExpired({ _tag: "ValidationError" })).toBe(false);
  });

  it("rejects a 403 shape — permission denied must not sign the user out", () => {
    // The API answers 403 for "signed in but not allowed"; treating that as an
    // expiry would log an organiser out of a wedding they simply can't edit.
    expect(isAuthExpired({ status: 403, error: "read_only_role" })).toBe(false);
  });

  it("survives values that have no useful string form", () => {
    expect(isAuthExpired(null)).toBe(false);
    expect(isAuthExpired(undefined)).toBe(false);
    expect(isAuthExpired(Object.create(null))).toBe(false);
  });
});

// The assignment `window.location.href = "/login?…"` is resolved against the
// document origin by the DOM, so these assert the absolute form.
describe("redirectToLogin", () => {
  const ORIGIN = "http://localhost:4322";
  const original = window.location.href;
  afterEach(() => {
    window.location.href = original;
  });

  it("remembers where the organiser was", () => {
    window.location.href = `${ORIGIN}/weddings/w1/guests?tab=rsvp#top`;
    redirectToLogin();
    expect(window.location.href).toBe(
      `${ORIGIN}/login?returnTo=` + encodeURIComponent("/weddings/w1/guests?tab=rsvp#top"),
    );
  });

  it("does not remember /login itself", () => {
    window.location.href = `${ORIGIN}/login?returnTo=%2Fwhatever`;
    redirectToLogin();
    expect(window.location.href).toBe(`${ORIGIN}/login`);
  });

  it("carries only a same-origin path, never an absolute URL", () => {
    window.location.href = `${ORIGIN}/weddings`;
    redirectToLogin();
    const returnTo = new URL(window.location.href).searchParams.get("returnTo");
    expect(returnTo).toBe("/weddings");
    expect(returnTo).not.toMatch(/^https?:/);
  });
});

describe("apiUrl", () => {
  it("prefixes the configured cire API origin", () => {
    expect(apiUrl("/api/organiser/weddings")).toMatch(/\/api\/organiser\/weddings$/);
  });
});
