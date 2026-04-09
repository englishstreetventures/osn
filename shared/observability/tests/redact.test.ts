import { describe, expect, it } from "vitest";
import { REDACT_KEYS, redact, REDACTION_PLACEHOLDER } from "../src/logger/redact";

describe("redact", () => {
  it("passes primitives through unchanged", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it("redacts top-level auth/credential keys", () => {
    const input = {
      userId: "u_123",
      password: "hunter2",
      accessToken: "eyJ...",
      refreshToken: "eyJ...",
      authorization: "Bearer ...",
      jwt: "eyJ...",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.userId).toBe("u_123");
    expect(out.password).toBe(REDACTION_PLACEHOLDER);
    expect(out.accessToken).toBe(REDACTION_PLACEHOLDER);
    expect(out.refreshToken).toBe(REDACTION_PLACEHOLDER);
    expect(out.authorization).toBe(REDACTION_PLACEHOLDER);
    expect(out.jwt).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts PII (email, phone, handle, displayName)", () => {
    const input = {
      userId: "u_123",
      email: "alice@example.com",
      phone: "+15551234567",
      handle: "alice",
      displayName: "Alice Smith",
      firstName: "Alice",
      lastName: "Smith",
      createdAtTs: 1234567890,
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.userId).toBe("u_123");
    expect(out.email).toBe(REDACTION_PLACEHOLDER);
    expect(out.phone).toBe(REDACTION_PLACEHOLDER);
    expect(out.handle).toBe(REDACTION_PLACEHOLDER);
    // S-M2: user-chosen name fields are redacted
    expect(out.displayName).toBe(REDACTION_PLACEHOLDER);
    expect(out.firstName).toBe(REDACTION_PLACEHOLDER);
    expect(out.lastName).toBe(REDACTION_PLACEHOLDER);
    // Non-sensitive fields pass through unchanged
    expect(out.createdAtTs).toBe(1234567890);
  });

  it("redacts nested object fields", () => {
    const input = {
      user: {
        id: "u_123",
        email: "alice@example.com",
        profile: {
          handle: "alice",
        },
      },
    };
    const out = redact(input) as {
      user: { id: string; email: string; profile: { handle: string } };
    };
    expect(out.user.id).toBe("u_123");
    expect(out.user.email).toBe(REDACTION_PLACEHOLDER);
    expect(out.user.profile.handle).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts inside arrays", () => {
    const input = [
      { id: "u_1", email: "a@example.com" },
      { id: "u_2", email: "b@example.com" },
    ];
    const out = redact(input) as Array<{ id: string; email: string }>;
    expect(out[0]?.id).toBe("u_1");
    expect(out[0]?.email).toBe(REDACTION_PLACEHOLDER);
    expect(out[1]?.id).toBe("u_2");
    expect(out[1]?.email).toBe(REDACTION_PLACEHOLDER);
  });

  it("is case-insensitive on keys", () => {
    const input = {
      Email: "alice@example.com",
      EMAIL: "alice@example.com",
      AccessToken: "eyJ...",
      ACCESS_TOKEN: "eyJ...",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.Email).toBe(REDACTION_PLACEHOLDER);
    expect(out.EMAIL).toBe(REDACTION_PLACEHOLDER);
    expect(out.AccessToken).toBe(REDACTION_PLACEHOLDER);
    expect(out.ACCESS_TOKEN).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts E2E encryption payloads (Zap / Signal)", () => {
    const input = {
      chatId: "chat_123",
      messageBody: "hello world",
      ciphertext: "base64stuff",
      plaintext: "hello",
      ratchetKey: "keybytes",
      identityKey: "keybytes",
      senderKey: "keybytes",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.chatId).toBe("chat_123");
    expect(out.messageBody).toBe(REDACTION_PLACEHOLDER);
    expect(out.ciphertext).toBe(REDACTION_PLACEHOLDER);
    expect(out.plaintext).toBe(REDACTION_PLACEHOLDER);
    expect(out.ratchetKey).toBe(REDACTION_PLACEHOLDER);
    expect(out.identityKey).toBe(REDACTION_PLACEHOLDER);
    expect(out.senderKey).toBe(REDACTION_PLACEHOLDER);
  });

  it("preserves Date values", () => {
    const now = new Date();
    const input = { createdAt: now, email: "a@b.com" };
    const out = redact(input) as { createdAt: Date; email: string };
    expect(out.createdAt).toBe(now);
    expect(out.email).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts fields on Error instances", () => {
    class CustomError extends Error {
      public readonly email: string;
      public readonly userId: string;
      constructor(email: string, userId: string) {
        super("something broke");
        this.email = email;
        this.userId = userId;
      }
    }
    const err = new CustomError("alice@example.com", "u_123");
    const out = redact(err) as {
      name: string;
      message: string;
      email: string;
      userId: string;
    };
    expect(out.name).toBe("Error");
    expect(out.message).toBe("something broke");
    expect(out.email).toBe(REDACTION_PLACEHOLDER);
    expect(out.userId).toBe("u_123");
  });

  it("throws on cyclic input", () => {
    const a: { self?: unknown } = {};
    a.self = a;
    expect(() => redact(a)).toThrow(/cyclic/);
  });

  it("does not mutate input", () => {
    const input = { email: "alice@example.com", userId: "u_1" };
    const snapshot = { ...input };
    redact(input);
    expect(input).toEqual(snapshot);
  });

  /**
   * Walks every entry in the deny-list and confirms it redacts.
   * Self-maintaining: any key added to (or removed from) REDACT_KEYS
   * automatically gets coverage. Guards against a future refactor
   * accidentally dropping a "non-negotiable" entry (per CLAUDE.md).
   */
  it("every entry in REDACT_KEYS is actually redacted", () => {
    expect(REDACT_KEYS.size).toBeGreaterThan(20);
    for (const key of REDACT_KEYS) {
      const input = { [key]: "sensitive-value" };
      const out = redact(input) as Record<string, unknown>;
      expect(out[key], `key "${key}" was not redacted`).toBe(REDACTION_PLACEHOLDER);
    }
  });

  it("explicitly asserts headers + crypto + signal keys stay on the list", () => {
    // These are the "non-negotiable" keys called out in CLAUDE.md.
    // Locking them with an explicit assertion here means a PR that
    // accidentally deletes any one of them will fail this test by name,
    // not just the generic loop above.
    const mustBeRedacted = [
      "cookie",
      "set-cookie",
      "setCookie",
      "authorization",
      "apiKey",
      "api_key",
      "privateKey",
      "private_key",
      "secretKey",
      "secret_key",
      "password_hash",
      "sessionToken",
      "session_token",
      "signalEnvelope",
      "signal_envelope",
      "prekey",
      "preKey",
      "senderKey",
      "sender_key",
      "identityKey",
      "identity_key",
      "ratchetKey",
      "ratchet_key",
    ];
    for (const key of mustBeRedacted) {
      expect(
        REDACT_KEYS.has(key.toLowerCase()),
        `deny-list is missing "${key}" — this is a non-negotiable key per CLAUDE.md`,
      ).toBe(true);
    }
  });
});
