import { createLoginClient, describeAuthError, LoginError, OsnApiError } from "@osn/client";
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

const PINNED: Record<string, string> = {
  NotAllowedError: "The passkey prompt was closed or timed out. Try again.",
  AbortError: "The passkey request was stopped. Try again.",
  InvalidStateError: "This device already has a passkey for this account.",
  SecurityError: "Your browser didn't allow a passkey here. Try another browser or device.",
  NotSupportedError: "This device can't use a passkey here. Try another device or a security key.",
};
const NAMES = [...Object.keys(PINNED), "ConstraintError", "UnknownError"];
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
      const sentence = describePasskeyError(thrown);
      expect(sentence).toBe(PINNED.NotAllowedError);
      expect(sentence).not.toContain("w3.org");
      expect(sentence).not.toContain("operation");
      expect(sentence).not.toContain("See:");
    },
  );

  it.each(CEREMONIES.flatMap((c) => NAMES.map((n) => [c, n] as const)))(
    "W2 (%s): a %s never shows its message",
    async (ceremony, name) => {
      const thrown = await failedCeremony(ceremony, new DOMException(`${MARKER} ${name}`, name));
      expect(describePasskeyError(thrown)).not.toContain(MARKER);
    },
  );

  // A copy test, not a redaction: #2044 replaces it with E2E checks or keeps it with a reason.
  it.each(CEREMONIES.flatMap((c) => Object.keys(PINNED).map((n) => [c, n] as const)))(
    "W3 (%s): a %s gets its own sentence",
    async (ceremony, name) => {
      const thrown = await failedCeremony(ceremony, new DOMException("browser text", name));
      expect(describePasskeyError(thrown)).toBe(PINNED[name]);
    },
  );

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
      expect(() => describePasskeyError(err)).not.toThrow();
      expect(describePasskeyError(err)).toBe(GENERAL);
    }
  });

  it("W5: no sentence blames a domain or names a product", () => {
    const sentences = [...Object.values(PINNED), GENERAL];
    for (const name of NAMES) sentences.push(describePasskeyError({ name }));
    for (const sentence of sentences) {
      expect(sentence.toLowerCase()).not.toMatch(/musubi|domain|http|\.social|osn/);
    }
  });

  it("W6: a server refusal in a passkey flow gets the map's passkey sentence", () => {
    const refused = new LoginError("invalid_request", 400, "invalid_request");
    expect(describePasskeyError(refused)).toBe(describeAuthError(refused, "passkey"));
    expect(describePasskeyError(refused)).not.toBe(GENERAL);
    const limited = new LoginError("rate_limited", 429, "rate_limited");
    expect(describePasskeyError(limited)).toBe(describeAuthError(limited));
    expect(describePasskeyError(limited).toLowerCase()).toContain("wait");
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
    const sentence = describePasskeyError(thrown);
    expect(sentence).toBe(describeAuthError(new OsnApiError("x", 0)));
    expect(sentence.toLowerCase()).toContain("connect");
    expect(sentence).not.toBe(GENERAL);
  });
});
