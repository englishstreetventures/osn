// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { redirectToLogin, signOutToLogin } from "../../src/lib/api";

/*
 * Where an expired session and a sign-out send the vendor. The sign-in panel
 * follows `returnTo` only when it is a same-origin path, so these hold what the
 * portal hands it: the page the vendor was on, never an absolute URL, never
 * `/login` itself, and nothing at all after a sign-out. The assignment is
 * resolved against the document's origin, so these read the absolute form.
 */

const ORIGIN = "http://localhost:4323";
const original = window.location.href;

afterEach(() => {
  window.location.href = original;
});

describe("redirectToLogin", () => {
  it("remembers the thread the vendor was reading", () => {
    window.location.href = `${ORIGIN}/#/orgs/org_1/threads/th_2`;
    redirectToLogin();
    expect(window.location.href).toBe(
      `${ORIGIN}/login?returnTo=` + encodeURIComponent("/#/orgs/org_1/threads/th_2"),
    );
  });

  it("does not remember /login itself", () => {
    window.location.href = `${ORIGIN}/login?returnTo=%2Fwhatever`;
    redirectToLogin();
    expect(window.location.href).toBe(`${ORIGIN}/login`);
  });

  it("carries only a same-origin path, never an absolute URL", () => {
    window.location.href = `${ORIGIN}/claim?code=abc`;
    redirectToLogin();
    const returnTo = new URL(window.location.href).searchParams.get("returnTo");
    expect(returnTo).toBe("/claim?code=abc");
  });
});

describe("signOutToLogin", () => {
  const ORIGIN = "http://localhost:4323";
  const original = window.location.href;
  afterEach(() => {
    window.location.href = original;
  });

  it("goes to the login page with nothing to resume, after the sign-out", async () => {
    // The next person to sign in on this device must not land on this page.
    window.location.href = `${ORIGIN}/#/orgs/org_1/threads/th_2`;
    await signOutToLogin(() => Promise.resolve());
    expect(window.location.href).toBe(`${ORIGIN}/login`);
  });

  it("keeps the expired-session redirect the sign-out sets off from carrying the page", async () => {
    // Signing out clears the session before the request returns, and the
    // app's guard redirects at once.
    window.location.href = `${ORIGIN}/#/orgs/org_1/threads/th_2`;
    await signOutToLogin(async () => {
      redirectToLogin();
      expect(window.location.href).toBe(`${ORIGIN}/login`);
      window.location.href = `${ORIGIN}/#/orgs/org_1/threads/th_2`;
    });
    expect(window.location.href).toBe(`${ORIGIN}/login`);
  });

  it("still leaves for the login page when the sign-out request fails", async () => {
    window.location.href = `${ORIGIN}/#/orgs/org_1/threads/th_2`;
    await expect(signOutToLogin(() => Promise.reject(new Error("offline")))).rejects.toThrow(
      "offline",
    );
    expect(window.location.href).toBe(`${ORIGIN}/login`);
  });
});
