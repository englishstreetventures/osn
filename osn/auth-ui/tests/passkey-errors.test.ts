import {
  AuthExpiredError,
  createLoginClient,
  describeAuthError,
  LoginError,
  OsnApiError,
} from "@osn/client";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describePasskeyError } from "../src/passkey-errors";

const RP_ID = "example.com";
const MARKER = "zq-marker-91c2";
const CHROME_NOT_ALLOWED =
  "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";

type Ceremony = "authentication" | "registration";
const CEREMONIES: Ceremony[] = ["authentication", "registration"];

afterEach(() => vi.unstubAllGlobals());

/**
 * Run the real `@simplewebauthn/browser` ceremony against a credential API that
 * rejects with `error`, and return what the ceremony threw. `PublicKeyCredential`
 * is stubbed so the library's support check passes, and `location` so its
 * `SecurityError` branch can read the host.
 */
async function failedCeremony(ceremony: Ceremony, error: unknown): Promise<unknown> {
  const fail = vi.fn(async () => {
    throw error;
  });
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", { credentials: { create: fail, get: fail } });
  vi.stubGlobal("location", { hostname: RP_ID });
  try {
    if (ceremony === "authentication") {
      await startAuthentication({ optionsJSON: { challenge: "AQID", rpId: RP_ID } });
    } else {
      await startRegistration({
        optionsJSON: {
          challenge: "AQID",
          rp: { name: "Example", id: RP_ID },
          user: { id: "BAUG", name: "alice", displayName: "Alice" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
      });
    }
  } catch (err) {
    return err;
  }
  throw new Error("expected the ceremony to fail");
}

/** The names whose sentence is the same for both ceremonies. */
const PINNED: Record<string, string> = {
  AbortError: "The passkey request was stopped. Try again.",
  SecurityError: "Your browser didn't allow a passkey here. Try another browser or device.",
  NotSupportedError: "This device can't use a passkey here. Try another device or a security key.",
  ConstraintError: "This device can't use a passkey here. Try another device or a security key.",
};
/** A closed prompt or a timeout: no passkey was used, or none was made. */
const NOT_ALLOWED: Record<Ceremony, string> = {
  authentication: "That passkey didn't work. Try again.",
  registration: "The passkey wasn't added. Try again.",
};
const ALREADY_REGISTERED = "This device already has a passkey for this account.";
const NAMES = [...Object.keys(PINNED), "NotAllowedError", "InvalidStateError", "UnknownError"];
const GENERAL = "Something went wrong with the passkey. Try again.";

describe("describePasskeyError", () => {
  it.each(CEREMONIES)(
    "W1 (%s): a NotAllowedError never shows the browser's own text",
    async (ceremony) => {
      const thrown = await failedCeremony(
        ceremony,
        new DOMException(CHROME_NOT_ALLOWED, "NotAllowedError"),
      );
      // The library passes the browser's message straight through.
      expect((thrown as Error).message).toBe(CHROME_NOT_ALLOWED);
      const sentence = describePasskeyError(thrown, ceremony);
      expect(sentence).toBe(NOT_ALLOWED[ceremony]);
      expect(sentence).not.toContain("w3.org");
      expect(sentence).not.toContain("operation");
      expect(sentence).not.toContain("See:");
    },
  );

  it.each(CEREMONIES.flatMap((c) => NAMES.map((n) => [c, n] as const)))(
    "W2 (%s): a %s never shows its message",
    async (ceremony, name) => {
      const thrown = await failedCeremony(ceremony, new DOMException(`${MARKER} ${name}`, name));
      for (const asked of CEREMONIES) {
        expect(describePasskeyError(thrown, asked)).not.toContain(MARKER);
      }
    },
  );

  // A copy test, not a redaction: #2044 replaces it with E2E checks or keeps it with a reason.
  it.each(CEREMONIES.flatMap((c) => Object.keys(PINNED).map((n) => [c, n] as const)))(
    "W3 (%s): a %s gets its own sentence in either ceremony",
    async (ceremony, name) => {
      const thrown = await failedCeremony(ceremony, new DOMException("browser text", name));
      for (const asked of CEREMONIES)
        expect(describePasskeyError(thrown, asked)).toBe(PINNED[name]);
    },
  );

  // A copy test, not a redaction: #2044 replaces it with E2E checks or keeps it with a reason.
  it.each(CEREMONIES)(
    "W3 (%s): a NotAllowedError gets the ceremony's own sentence",
    async (ceremony) => {
      const thrown = await failedCeremony(
        ceremony,
        new DOMException("browser text", "NotAllowedError"),
      );
      expect(describePasskeyError(thrown, ceremony)).toBe(NOT_ALLOWED[ceremony]);
    },
  );

  // A copy test, not a redaction: #2044 replaces it with E2E checks or keeps it with a reason.
  it("W3: an InvalidStateError says the passkey exists only when adding one", async () => {
    const adding = await failedCeremony(
      "registration",
      new DOMException("browser text", "InvalidStateError"),
    );
    expect(describePasskeyError(adding, "registration")).toBe(ALREADY_REGISTERED);
    const using = await failedCeremony(
      "authentication",
      new DOMException("browser text", "InvalidStateError"),
    );
    expect(describePasskeyError(using, "authentication")).toBe(GENERAL);
  });

  it("W4: anything it does not know gets the general sentence, without throwing", async () => {
    const throwingName = {
      get name(): string {
        throw new Error("boom");
      },
    };
    const { proxy, revoke } = Proxy.revocable({ name: "NotAllowedError" }, {});
    revoke();
    const odd: unknown[] = [
      await failedCeremony("authentication", new DOMException("x", "UnknownError")),
      new Error("WebAuthn is not supported in this browser"),
      new TypeError("bad options"),
      "NotAllowedError",
      null,
      undefined,
      42,
      { name: "__proto__" },
      { name: "constructor" },
      { name: "toString" },
      throwingName,
      proxy,
      Object.create(null) as object,
    ];
    for (const err of odd) {
      for (const ceremony of CEREMONIES) {
        expect(() => describePasskeyError(err, ceremony)).not.toThrow();
        expect(describePasskeyError(err, ceremony)).toBe(GENERAL);
      }
    }
    // A ceremony from untyped code that is not one of the two.
    const refused = new DOMException("x", "NotAllowedError");
    for (const ceremony of ["__proto__", "constructor", "signup", undefined]) {
      const asked = ceremony as unknown as Ceremony;
      expect(() => describePasskeyError(refused, asked)).not.toThrow();
      expect(describePasskeyError(refused, asked)).toBe(GENERAL);
    }
  });

  it("W5: no sentence blames a domain or names a product", () => {
    const sentences = [
      ...Object.values(PINNED),
      ...Object.values(NOT_ALLOWED),
      ALREADY_REGISTERED,
      GENERAL,
    ];
    for (const name of NAMES) {
      for (const ceremony of CEREMONIES) sentences.push(describePasskeyError({ name }, ceremony));
    }
    for (const sentence of sentences) {
      expect(sentence.toLowerCase()).not.toMatch(/musubi|domain|http|\.social|osn/);
    }
  });

  it("W6: a server refusal in a passkey flow gets the map's sentence for that ceremony", () => {
    const refused = new LoginError("invalid_request", 400, "invalid_request");
    const signingIn = describePasskeyError(refused, "authentication");
    const adding = describePasskeyError(refused, "registration");
    expect(signingIn).toBe(describeAuthError(refused, "passkey"));
    expect(adding).toBe(describeAuthError(refused, "new-passkey"));
    expect(adding).not.toBe(signingIn);
    for (const sentence of [signingIn, adding]) {
      expect(sentence).not.toBe(GENERAL);
      expect(sentence).not.toBe(describeAuthError(refused));
    }
    const limited = new LoginError("rate_limited", 429, "rate_limited");
    for (const ceremony of CEREMONIES) {
      expect(describePasskeyError(limited, ceremony)).toBe(describeAuthError(limited));
      expect(describePasskeyError(limited, ceremony).toLowerCase()).toContain("wait");
    }
  });

  it("W6: an expired session in a passkey flow gets the map's session sentence", () => {
    const session = describeAuthError(new AuthExpiredError({}));
    expect(session).not.toBe(GENERAL);
    for (const ceremony of CEREMONIES) {
      expect(describePasskeyError(new AuthExpiredError({}), ceremony)).toBe(session);
      expect(describePasskeyError({ _tag: "AuthExpiredError" }, ceremony)).toBe(session);
    }
  });

  it("W7: a passkey flow that cannot reach the server gets the connection sentence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const client = createLoginClient({ issuerUrl: "https://id.example.com" });
    let thrown: unknown;
    try {
      await client.passkeyBegin("alice");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OsnApiError);
    const sentence = describePasskeyError(thrown, "authentication");
    expect(sentence).toBe(describeAuthError(new OsnApiError("x", 0)));
    expect(sentence.toLowerCase()).toContain("connect");
    expect(sentence).not.toBe(GENERAL);
  });
});
