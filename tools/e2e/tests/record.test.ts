import { describe, expect, test } from "bun:test";

import { buildResults, normalisePath, requestLine, requestSet, stableJson } from "../src/record";

const labels = { "http://localhost:4000": "osn-api", "http://localhost:3001": "pulse-api" };

describe("normalisePath", () => {
  test("replaces server-generated ids and keeps fixed words", () => {
    expect(normalisePath("/events/evt_1a2b3c4d5e6f/rsvps")).toBe("/events/:id/rsvps");
    expect(normalisePath("/guests/b0000000-0000-4000-8000-000000000001")).toBe("/guests/:id");
    expect(normalisePath("/challenge/aZ3_kP9qLm2Xc7Vb8Nw1Rt")).toBe("/challenge/:id");
  });

  // The random part of an id can be drawn with no digit in it: twelve hex
  // digits all a-f about once in 130,000 ids, a 22-character token about once
  // in 40, a 43-character one about once in 1,500. The line must not change
  // between runs when it is.
  test("replaces an id whose random part drew no digit", () => {
    expect(normalisePath("/register/signup_abcdefabcdef/status")).toBe("/register/:id/status");
    expect(normalisePath("/passkeys/pk_fedcbafedcba")).toBe("/passkeys/:id");
    expect(normalisePath("/x/emailchange_abcdefabcdef")).toBe("/x/:id");
    expect(normalisePath("/x/aenr_abcdefabcdefabcd")).toBe("/x/:id");
    expect(normalisePath("/step-up/requests/aZbYcXdWeVfUgThSiRjQkP")).toBe("/step-up/requests/:id");
    expect(normalisePath("/x/aZbYcXdWeVfUgThSiRjQkPlOmNnMoLpKqJrIsHtGu_-")).toBe("/x/:id");
  });

  test("leaves slugs, handles and words alone", () => {
    expect(normalisePath("/api/invite/cire-wedding/registry")).toBe(
      "/api/invite/cire-wedding/registry",
    );
    expect(normalisePath("/handle/e2e_ada")).toBe("/handle/e2e_ada");
    expect(normalisePath("/handle/dev_bootstrap")).toBe("/handle/dev_bootstrap");
    expect(normalisePath("/weddings/wed_bootstrap")).toBe("/weddings/wed_bootstrap");
    expect(normalisePath("/email-verification-nonce")).toBe("/email-verification-nonce");
    expect(normalisePath("/x/household-rsvp-changes")).toBe("/x/household-rsvp-changes");
    expect(normalisePath("/api/auth/oidc/callback")).toBe("/api/auth/oidc/callback");
  });
});

describe("requestLine", () => {
  test("drops the query string, which carries OIDC state, nonce and PKCE values", () => {
    expect(
      requestLine(
        "GET",
        "http://localhost:3001/api/auth/oidc/callback?code=cod_x1&state=abc",
        302,
        labels,
      ),
    ).toBe("GET pulse-api /api/auth/oidc/callback 302");
  });

  test("keeps only API origins", () => {
    expect(requestLine("GET", "http://localhost:1420/src/app.tsx", 200, labels)).toBeNull();
    expect(requestLine("GET", "not a url", 200, labels)).toBeNull();
  });
});

describe("requestSet", () => {
  test("is the same for the same calls in any order or number", () => {
    expect(requestSet(["b", "a", "b"])).toEqual(requestSet(["a", "b"]));
  });
});

describe("stableJson", () => {
  test("sorts keys at every depth, so insertion order never shows", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      stableJson({ a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 }),
    );
    expect(stableJson({ a: 1 }).endsWith("}\n")).toBe(true);
  });
});

describe("buildResults", () => {
  test("orders flows by name, whatever order they finished in", () => {
    const flow = (name: string) => ({
      flow: name,
      status: "passed",
      steps: [],
      requests: [],
      assertions: [],
    });
    const results = buildResults("T0", [flow("pulse"), flow("cire"), flow("musubi")]);
    expect(results.flows.map((f) => f.flow)).toEqual(["cire", "musubi", "pulse"]);
  });
});
