import { describe, expect, it } from "vitest";

import { OsnApiError } from "../src/api-error";
import { AuthorizeError, type AuthorizeErrorCode } from "../src/authorize";
import { describeAuthError, type AuthErrorContext } from "../src/error-copy";
import { AuthExpiredError, ProfileManagementError } from "../src/errors";
import { LoginError } from "../src/login";

/**
 * Every `(status, code)` a client of this package can receive, kept here
 * rather than imported from `src`, so a code the map drops shows up as a
 * failing row. `undefined` is a body with no usable `error` field.
 */
const SERVER_ANSWERS: ReadonlyArray<readonly [status: number, code: string | undefined]> = [
  [400, "invalid_request"], // osn/api/src/lib/public-error.ts:94-97,105
  [400, "turnstile_failed"], // osn/api/src/routes/auth/context.ts:213
  [400, "handle_mismatch"], // osn/api/src/routes/account-erasure.ts:151
  [400, "login_required"], // osn/api/src/routes/auth/oidc.ts:562
  [401, "unauthorized"], // every bearer-gated route
  [401, "invalid_client"], // osn/api/src/routes/auth/oidc.ts:562
  [403, "step_up_required"], // e.g. osn/api/src/routes/auth/passkey-management.ts
  [403, "forbidden"], // osn/api/src/lib/origin-guard.ts:117,123
  [404, "not_found"], // osn/api/src/routes/auth/oidc.ts:822
  [404, "invalid_request"], // osn/api/src/routes/auth/oidc.ts:433
  [404, "invalid_client"], // osn/api/src/routes/auth/oidc.ts:440
  [409, "session_stale"], // osn/api/src/routes/auth/passkey-enroll.ts:172
  [422, "age_restricted"], // osn/api/src/lib/public-error.ts:89-92
  [422, undefined], // framework body validation: no `error` field
  [429, "rate_limited"], // osn/api/src/routes/auth/context.ts:175,185
  [500, "internal_error"], // osn/api/src/lib/public-error.ts:98
  [502, undefined], // a non-JSON page from the edge
  [503, "temporarily_unavailable"], // osn/api/src/lib/public-error.ts:103
];

/** `AuthorizeErrorCode`s at each status `authorize.ts` builds them with. */
const AUTHORIZE_ANSWERS: ReadonlyArray<readonly [AuthorizeErrorCode, number]> = [
  ["invalid_request", 400],
  ["invalid_request", 404],
  ["login_required", 400],
  ["unauthorized", 401],
  ["invalid_client", 401],
  ["invalid_client", 404],
  ["rate_limited", 429],
  ["unknown", 0],
  ["unknown", 400],
  ["unknown", 500],
];

const CONTEXTS: ReadonlyArray<AuthErrorContext | undefined> = [
  undefined,
  "code",
  "recovery",
  "passkey",
  "details",
];

const MARKER = "zq-marker-7f3a";
const W3C_URL = "https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client";

const api = (status: number, code?: string, message = `${MARKER} ${W3C_URL}`) =>
  new OsnApiError(message, status, code);

const GENERAL = describeAuthError(null);
const CONNECTION = describeAuthError(api(0));
const WAIT = describeAuthError(api(429));
const SESSION = describeAuthError(api(401, "unauthorized"));
const AGE = describeAuthError(api(422, "age_restricted"));

/** Every sentence the map can return, gathered by walking its inputs. */
function everySentence(): Set<string> {
  const sentences = new Set<string>([GENERAL, CONNECTION, WAIT, SESSION]);
  const statuses = [0, 200, 400, 401, 403, 404, 409, 418, 422, 429, 500, 502, 503];
  const codes = [...SERVER_ANSWERS.map(([, c]) => c), ...AUTHORIZE_ANSWERS.map(([c]) => c)];
  for (const status of statuses) {
    for (const code of [...codes, undefined, "made_up_code"]) {
      for (const context of CONTEXTS) sentences.add(describeAuthError(api(status, code), context));
    }
  }
  sentences.add(describeAuthError(new AuthExpiredError({})));
  return sentences;
}

describe("describeAuthError", () => {
  it("C1: never shows the raw code or any snake_case token", () => {
    for (const [status, code] of SERVER_ANSWERS) {
      for (const context of CONTEXTS) {
        const sentence = describeAuthError(api(status, code), context);
        for (const shown of code === undefined ? [] : [code]) expect(sentence).not.toContain(shown);
        expect(sentence).not.toMatch(/[a-z0-9]+_[a-z0-9_]+/i);
      }
    }
  });

  it("C2: never shows the error's message, a URL from it, or the client's fallback text", () => {
    const errors: unknown[] = [
      ...SERVER_ANSWERS.map(([status, code]) => api(status, code)),
      ...AUTHORIZE_ANSWERS.map(
        ([code, status]) => new AuthorizeError(code, status, `${MARKER} ${W3C_URL}`),
      ),
      new LoginError(`Request failed: 400`, 400),
      new TypeError(`${MARKER} Failed to fetch`),
      new SyntaxError(`${MARKER} Unexpected token <`),
      new ProfileManagementError({ cause: `${MARKER}`, status: 400, code: "invalid_request" }),
    ];
    for (const err of errors) {
      for (const context of CONTEXTS) {
        const sentence = describeAuthError(err, context);
        expect(sentence).not.toContain(MARKER);
        expect(sentence).not.toContain("w3.org");
        expect(sentence).not.toContain("Request failed");
      }
    }
  });

  it("C3: an unknown code takes the status class, never the code", () => {
    expect(describeAuthError(api(400, "made_up_code"))).toBe(describeAuthError(api(400)));
    expect(describeAuthError(api(500, "made_up_code"))).toBe(describeAuthError(api(500)));
    expect(describeAuthError(api(418, "made_up_code"))).toBe(GENERAL);
    for (const status of [400, 418, 500]) {
      expect(describeAuthError(api(status, "made_up_code"))).not.toContain("made_up_code");
    }
  });

  it("C4: a prototype key as the code falls through to the status class, without throwing", () => {
    for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      for (const status of [400, 403]) {
        const sentence = describeAuthError(api(status, code));
        expect(typeof sentence).toBe("string");
        expect(sentence).toBe(describeAuthError(api(status)));
      }
    }
  });

  it("C5: two errors with the same status and code get the same sentence, whatever else differs", () => {
    for (const [status, code] of SERVER_ANSWERS) {
      const plain = new OsnApiError("one message", status, code);
      const other = Object.assign(new LoginError("another message entirely", status, code), {
        name: "SomethingElse",
        cause: new Error("a cause"),
        error_description: "Unknown or expired request",
        detail: "the account does not exist",
      });
      for (const context of CONTEXTS) {
        expect(describeAuthError(other, context)).toBe(describeAuthError(plain, context));
      }
    }
  });

  it("C6: a 429 names the wait without a time", () => {
    const cases: unknown[] = [
      api(429),
      api(429, "rate_limited"),
      api(429, "invalid_request"),
      api(429, "made_up_code"),
      new AuthorizeError("rate_limited", 429, "Too many attempts. Try again in a minute."),
    ];
    for (const err of cases) {
      for (const context of CONTEXTS) {
        const sentence = describeAuthError(err, context);
        expect(sentence).toBe(WAIT);
      }
    }
    expect(WAIT.toLowerCase()).toContain("wait");
    expect(WAIT).not.toMatch(/\d/);
    expect(WAIT.toLowerCase()).not.toMatch(/minute|hour|second/);
  });

  // A copy test, not a redaction: #2044 replaces it with E2E checks or keeps it with a reason.
  it("C7: every status and code a client receives has a sentence", () => {
    const errors: unknown[] = [
      ...SERVER_ANSWERS.map(([status, code]) => api(status, code)),
      ...AUTHORIZE_ANSWERS.map(([code, status]) => new AuthorizeError(code, status, "x")),
    ];
    for (const err of errors) {
      for (const context of CONTEXTS) {
        const sentence = describeAuthError(err, context);
        expect(sentence.length).toBeGreaterThan(0);
        expect(sentence.endsWith(".")).toBe(true);
      }
    }
  });

  // A copy test, not a redaction: #2044 replaces it with E2E checks or keeps it with a reason.
  it("C8: a client-wrapped transport failure gets the connection sentence, and nothing else does", () => {
    expect(CONNECTION).not.toBe(GENERAL);
    expect(CONNECTION.toLowerCase()).toContain("connect");
    expect(describeAuthError(new LoginError("Could not reach the server", 0))).toBe(CONNECTION);
    expect(describeAuthError(new AuthorizeError("unknown", 0, "Could not reach"))).toBe(CONNECTION);
    expect(describeAuthError(new TypeError("Failed to fetch"))).toBe(GENERAL);
    expect(describeAuthError(new SyntaxError("Unexpected token <"))).toBe(GENERAL);
  });

  // A copy test, not a redaction: #2044 replaces it with E2E checks or keeps it with a reason.
  it("C9: an expired session gets the session sentence", () => {
    expect(SESSION.toLowerCase()).toContain("sign in");
    expect(describeAuthError(new AuthExpiredError({}))).toBe(SESSION);
    expect(describeAuthError({ _tag: "AuthExpiredError" })).toBe(SESSION);
    expect(describeAuthError(api(401))).toBe(SESSION);
  });

  it("C10: odd input gets the general sentence and never throws", () => {
    const throwingStatus = {
      get status(): number {
        throw new Error("boom");
      },
    };
    const { proxy, revoke } = Proxy.revocable({ status: 400, code: "invalid_request" }, {});
    revoke();
    const nullProto = Object.assign(Object.create(null) as object, { status: "400" });
    const odd: unknown[] = [
      "invalid_request",
      "rate_limited",
      null,
      undefined,
      42,
      throwingStatus,
      proxy,
      nullProto,
      { status: Number.NaN, code: "rate_limited" },
      { status: Number.POSITIVE_INFINITY },
    ];
    for (const err of odd) {
      for (const context of CONTEXTS) {
        expect(() => describeAuthError(err, context)).not.toThrow();
        expect(describeAuthError(err, context)).toBe(GENERAL);
      }
    }
  });

  // A copy test, not a redaction: #2044 replaces it with E2E checks or keeps it with a reason.
  it("C11: a 2xx the client could not use gets the general sentence", () => {
    expect(describeAuthError(api(200))).toBe(GENERAL);
    expect(describeAuthError(api(204))).toBe(GENERAL);
  });

  it("C12: no sentence names a product, and only the age gate carries a number", () => {
    const sentences = [...everySentence()];
    expect(sentences).toContain(AGE);
    for (const sentence of sentences) {
      expect(sentence.toLowerCase()).not.toMatch(/musubi|osn|\.social/);
      expect(sentence.toLowerCase()).not.toMatch(/minute|hour|second|attempts left/);
    }
    for (const sentence of sentences.filter((s) => s !== AGE)) {
      expect(sentence).not.toMatch(/\d/);
    }
  });

  it("C13: a ProfileManagementError is read by its status and code", () => {
    const limited = new ProfileManagementError({
      cause: "Request failed: 429",
      status: 429,
      code: "rate_limited",
    });
    expect(describeAuthError(limited)).toBe(WAIT);
    expect(describeAuthError(new ProfileManagementError({ cause: "No session available" }))).toBe(
      GENERAL,
    );
  });

  it("C14: the code and recovery sentences tell a locked-out person to wait", () => {
    for (const context of ["code", "recovery"] as const) {
      const sentence = describeAuthError(api(400, "invalid_request"), context);
      expect(sentence.toLowerCase()).toContain("wait");
      expect(sentence).not.toMatch(/\d/);
      expect(describeAuthError(api(422), context)).toBe(sentence);
    }
  });
});
