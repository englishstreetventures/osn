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

  it("redacts OAuth / first-party token responses", () => {
    const input = {
      profileId: "u_123",
      accessToken: "eyJ...",
      refreshToken: "eyJ...",
      idToken: "eyJ...",
      enrollmentToken: "enroll_xyz",
      access_token: "eyJ...",
      refresh_token: "eyJ...",
      id_token: "eyJ...",
      enrollment_token: "enroll_xyz",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.profileId).toBe("u_123");
    expect(out.accessToken).toBe(REDACTION_PLACEHOLDER);
    expect(out.refreshToken).toBe(REDACTION_PLACEHOLDER);
    expect(out.idToken).toBe(REDACTION_PLACEHOLDER);
    expect(out.enrollmentToken).toBe(REDACTION_PLACEHOLDER);
    expect(out.access_token).toBe(REDACTION_PLACEHOLDER);
    expect(out.refresh_token).toBe(REDACTION_PLACEHOLDER);
    expect(out.id_token).toBe(REDACTION_PLACEHOLDER);
    expect(out.enrollment_token).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts the Authorization header", () => {
    const input = {
      url: "/graph/internal/connections",
      headers: { authorization: "ARC eyJ..." },
    };
    const out = redact(input) as { url: string; headers: { authorization: string } };
    expect(out.url).toBe("/graph/internal/connections");
    expect(out.headers.authorization).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts recovery codes (Copenhagen Book M2) in both camelCase and snake_case", () => {
    const input = {
      accountId: "acc_123",
      recoveryCode: "abcd-1234-5678-ef00",
      recovery_code: "abcd-1234-5678-ef00",
      recoveryCodes: ["abcd-1234-5678-ef00"],
      recovery_codes: ["abcd-1234-5678-ef00"],
      codeHash: "ab".repeat(32),
      code_hash: "ab".repeat(32),
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.accountId).toBe(REDACTION_PLACEHOLDER);
    expect(out.recoveryCode).toBe(REDACTION_PLACEHOLDER);
    expect(out.recovery_code).toBe(REDACTION_PLACEHOLDER);
    expect(out.recoveryCodes).toBe(REDACTION_PLACEHOLDER);
    expect(out.recovery_codes).toBe(REDACTION_PLACEHOLDER);
    expect(out.codeHash).toBe(REDACTION_PLACEHOLDER);
    expect(out.code_hash).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts WebAuthn assertion bodies", () => {
    const input = {
      identifier: "u_123",
      assertion: { id: "...", response: { signature: "..." } },
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.identifier).toBe("u_123");
    expect(out.assertion).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts ARC private key handles", () => {
    const input = {
      iss: "pulse-api",
      privateKey: "<CryptoKey>",
      private_key: "<jwk-string>",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.iss).toBe("pulse-api");
    expect(out.privateKey).toBe(REDACTION_PLACEHOLDER);
    expect(out.private_key).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts accountId to prevent multi-profile correlation", () => {
    const input = {
      profileId: "usr_123",
      accountId: "acc_456",
      account_id: "acc_456",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.profileId).toBe("usr_123");
    expect(out.accountId).toBe(REDACTION_PLACEHOLDER);
    expect(out.account_id).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts session familyId to prevent cross-rotation correlation", () => {
    const input = {
      sessionId: "abc123",
      familyId: "sfam_xyz",
      family_id: "sfam_xyz",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.sessionId).toBe("abc123");
    expect(out.familyId).toBe(REDACTION_PLACEHOLDER);
    expect(out.family_id).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts user PII (email, handle, displayName) but keeps profileId", () => {
    const input = {
      profileId: "u_123",
      email: "alice@example.com",
      handle: "alice",
      displayName: "Alice Smith",
      display_name: "Alice Smith",
      createdAtTs: 1234567890,
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.profileId).toBe("u_123");
    expect(out.email).toBe(REDACTION_PLACEHOLDER);
    expect(out.handle).toBe(REDACTION_PLACEHOLDER);
    expect(out.displayName).toBe(REDACTION_PLACEHOLDER);
    expect(out.display_name).toBe(REDACTION_PLACEHOLDER);
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
      public readonly profileId: string;
      constructor(email: string, profileId: string) {
        super("something broke");
        this.email = email;
        this.profileId = profileId;
      }
    }
    const err = new CustomError("alice@example.com", "u_123");
    const out = redact(err) as {
      name: string;
      message: string;
      email: string;
      profileId: string;
    };
    expect(out.name).toBe("Error");
    expect(out.message).toBe("something broke");
    expect(out.email).toBe(REDACTION_PLACEHOLDER);
    expect(out.profileId).toBe("u_123");
  });

  it("throws on cyclic input", () => {
    const a: { self?: unknown } = {};
    a.self = a;
    expect(() => redact(a)).toThrow(/cyclic/);
  });

  it("does not mutate input", () => {
    const input = { email: "alice@example.com", profileId: "u_1" };
    const snapshot = { ...input };
    redact(input);
    expect(input).toEqual(snapshot);
  });

  /**
   * Walks every entry in the deny-list and confirms it redacts.
   * Self-maintaining: any key added to (or removed from) REDACT_KEYS
   * automatically gets coverage. Guards against a future refactor
   * accidentally dropping an entry without updating the explicit
   * assertion below.
   */
  it("every entry in REDACT_KEYS is actually redacted", () => {
    expect(REDACT_KEYS.size).toBeGreaterThan(0);
    for (const key of REDACT_KEYS) {
      const input = { [key]: "sensitive-value" };
      const out = redact(input) as Record<string, unknown>;
      expect(out[key], `key "${key}" was not redacted`).toBe(REDACTION_PLACEHOLDER);
    }
  });

  /**
   * Deliberately-removed keys pass through unchanged. This is a behavioural
   * regression anchor: the file header in `src/logger/redact.ts` documents
   * the "real fields only" rule, and this test makes that intent executable
   * so a well-meaning "let's add password back for safety" PR has to
   * acknowledge it. Mirrors the historical S-M31 / S-H21 trim decision.
   */
  it("no longer scrubs keys that do not correspond to real fields", () => {
    const input = {
      // Auth / credentials that don't exist as field names:
      password: "hunter2",
      passwordHash: "hash",
      otp: "000000",
      otpCode: "000000",
      jwt: "eyJ...",
      sessionToken: "tok",
      // cookie: moved to deny-list (C3 — HttpOnly session cookies)
      apiKey: "sk_live_",
      secretKey: "sk",
      // E2E / Signal — no messaging impl yet:
      ciphertext: "aGVsbG8=",
      plaintext: "hello",
      ratchetKey: "k",
      senderKey: "k",
      identityKey: "k",
      messageBody: "hi",
      signalEnvelope: "env",
      prekey: "pk",
      // PII fields that don't exist in the schema:
      firstName: "Alice",
      lastName: "Smith",
      fullName: "Alice Smith",
      legalName: "Alice Smith",
      dob: "1990-01-01",
      address: "1 Test St",
      phone: "+15551234567",
      ssn: "000-00-0000",
      taxId: "TAX",
    };
    const out = redact(input) as Record<string, string>;
    for (const [k, v] of Object.entries(input)) {
      expect(out[k], `${k} should pass through unchanged`).toBe(v);
    }
  });

  /**
   * Locks the exact deny-list so a PR that adds or removes a key has to
   * touch this assertion as well — forcing the author to acknowledge the
   * change. The deny-list is small on purpose; see the file header in
   * src/logger/redact.ts for the criteria for adding entries.
   */
  it("deny-list contains the documented set of keys (and only that set)", () => {
    const expected = [
      "authorization",
      "cookie",
      "__host-osn_session",
      "osn_session",
      "accesstoken",
      "access_token",
      "refreshtoken",
      "refresh_token",
      "idtoken",
      "id_token",
      "enrollmenttoken",
      "enrollment_token",
      "recoverycode",
      "recovery_code",
      "recoverycodes",
      "recovery_codes",
      "codehash",
      "code_hash",
      "assertion",
      "privatekey",
      "private_key",
      "accountid",
      "account_id",
      "familyid",
      "family_id",
      "email",
      "handle",
      "displayname",
      "display_name",
    ].toSorted();
    expect([...REDACT_KEYS].toSorted()).toEqual(expected);
  });
});
