import { describe, expect, it } from "vitest";

import {
  decryptTotpSecret,
  encryptTotpSecret,
  fromJsonSafe,
  generateEphemeralTotpEncryptionKey,
  importTotpEncryptionKey,
  toJsonSafe,
  TOTP_KEY_VERSION,
} from "../../src/lib/totp-secret-crypto";

const ACCOUNT = "acc_abc123";
const OTHER_ACCOUNT = "acc_def456";
const SECRET = new Uint8Array(20).fill(7);

const validKeyB64 = Buffer.from("k".repeat(32)).toString("base64");

describe("importTotpEncryptionKey", () => {
  it("imports exactly 32 decoded bytes", async () => {
    const key = await importTotpEncryptionKey(validKeyB64);
    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
  });

  it("refuses a key that is not extractable", async () => {
    const key = await importTotpEncryptionKey(validKeyB64);
    // Non-extractable so a bug cannot serialise it into a log or a response.
    expect(key.extractable).toBe(false);
  });

  // The guard is only verified once it has been seen to fail.
  it.each([
    ["too short", Buffer.from("k".repeat(31)).toString("base64")],
    ["too long", Buffer.from("k".repeat(33)).toString("base64")],
    ["empty", ""],
    ["not base64 at all", "!!!!"],
  ])("throws on a key that is %s", async (_label, value) => {
    await expect(importTotpEncryptionKey(value)).rejects.toThrow(/OSN_TOTP_ENCRYPTION_KEY/);
  });

  it("names no part of the value in the error", async () => {
    const secretish = Buffer.from("hunter2hunter2hunter2").toString("base64");
    await expect(importTotpEncryptionKey(secretish)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secretish) }) as Error,
    );
  });

  it("states the requirement without publishing the decoded length", async () => {
    // `index.ts` turns a boot failure into the body of an UNAUTHENTICATED 503,
    // so the decoded length — a property of the secret's value, and the same
    // thing every sibling guard declines to interpolate — must not appear in
    // the message. The operator gets it through `onInvalidLength` instead.
    const reported: number[] = [];
    await expect(
      importTotpEncryptionKey(Buffer.from("k".repeat(31)).toString("base64"), (n) => {
        reported.push(n);
      }),
    ).rejects.toThrow(/^OSN_TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes$/);
    expect(reported).toEqual([31]);
  });

  it("does not call onInvalidLength for a key of the right length", async () => {
    const reported: number[] = [];
    await importTotpEncryptionKey(validKeyB64, (n) => {
      reported.push(n);
    });
    expect(reported).toEqual([]);
  });
});

describe("encrypt / decrypt round trip", () => {
  it("recovers the exact secret", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const encrypted = await encryptTotpSecret(key, ACCOUNT, SECRET);
    const back = await decryptTotpSecret(key, ACCOUNT, {
      secretCiphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: encrypted.keyVersion,
    });
    expect(back).toEqual(SECRET);
  });

  it("never stores the plaintext in the ciphertext", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const { ciphertext } = await encryptTotpSecret(key, ACCOUNT, SECRET);
    expect(Buffer.from(ciphertext).includes(Buffer.from(SECRET))).toBe(false);
  });

  it("uses a fresh IV per encryption, so the same secret never repeats a ciphertext", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const a = await encryptTotpSecret(key, ACCOUNT, SECRET);
    const b = await encryptTotpSecret(key, ACCOUNT, SECRET);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("stamps the current key version", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const encrypted = await encryptTotpSecret(key, ACCOUNT, SECRET);
    expect(encrypted.keyVersion).toBe(TOTP_KEY_VERSION);
  });
});

describe("the account is bound into the ciphertext", () => {
  it("refuses to decrypt a row moved to another account", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const encrypted = await encryptTotpSecret(key, ACCOUNT, SECRET);
    // The whole point of the AAD: someone with write access to D1 cannot copy
    // a victim's credential row onto an account they control and then step up
    // with their own authenticator.
    await expect(
      decryptTotpSecret(key, OTHER_ACCOUNT, {
        secretCiphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        keyVersion: encrypted.keyVersion,
      }),
    ).rejects.toThrow(/operation-specific reason/);
  });

  it("refuses to decrypt under a different key", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const other = await generateEphemeralTotpEncryptionKey();
    const encrypted = await encryptTotpSecret(key, ACCOUNT, SECRET);
    await expect(
      decryptTotpSecret(other, ACCOUNT, {
        secretCiphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        keyVersion: encrypted.keyVersion,
      }),
    ).rejects.toThrow(/operation-specific reason/);
  });

  it("refuses a tampered ciphertext rather than returning plausible bytes", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const encrypted = await encryptTotpSecret(key, ACCOUNT, SECRET);
    const tampered = new Uint8Array(encrypted.ciphertext);
    tampered[0] ^= 0xff;
    await expect(
      decryptTotpSecret(key, ACCOUNT, {
        secretCiphertext: tampered,
        iv: encrypted.iv,
        keyVersion: encrypted.keyVersion,
      }),
    ).rejects.toThrow(/operation-specific reason/);
  });

  it("refuses a key version it has no key for", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const encrypted = await encryptTotpSecret(key, ACCOUNT, SECRET);
    await expect(
      decryptTotpSecret(key, ACCOUNT, {
        secretCiphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        keyVersion: TOTP_KEY_VERSION + 1,
      }),
    ).rejects.toThrow(/key version/);
  });
});

describe("the ceremony-store shape survives JSON", () => {
  // The in-memory ceremony store keeps the value by reference; the Redis one
  // round-trips it through JSON.stringify. A Uint8Array in the entry would pass
  // every test on the first and come back from Upstash as {"0":12,"1":200,…}.
  it("survives a stringify/parse cycle and still decrypts", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const encrypted = await encryptTotpSecret(key, ACCOUNT, SECRET);

    const throughJson = JSON.parse(JSON.stringify(toJsonSafe(encrypted))) as ReturnType<
      typeof toJsonSafe
    >;
    const back = await decryptTotpSecret(key, ACCOUNT, fromJsonSafe(throughJson));

    expect(back).toEqual(SECRET);
  });

  it("carries only JSON-native values", () => {
    const shape = toJsonSafe({ ciphertext: SECRET, iv: new Uint8Array(12), keyVersion: 1 });
    expect(typeof shape.ciphertextB64).toBe("string");
    expect(typeof shape.ivB64).toBe("string");
    expect(typeof shape.keyVersion).toBe("number");
  });
});
