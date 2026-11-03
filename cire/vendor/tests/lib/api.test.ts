// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { leaveForLogin, redirectToLogin } from "../../src/lib/api";

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

describe("leaveForLogin", () => {
  it("goes to the login page with nothing to resume, after a sign-out", () => {
    window.location.href = `${ORIGIN}/#/orgs/org_1/threads/th_2`;
    leaveForLogin();
    expect(window.location.href).toBe(`${ORIGIN}/login`);
  });
});
