import { describe, expect, it } from "vitest";

import {
  createTotpKeyRing,
  currentTotpKeyVersion,
  decryptTotpSecret,
  encryptTotpSecret,
  fromJsonSafe,
  generateEphemeralTotpEncryptionKey,
  importTotpEncryptionKey,
  toJsonSafe,
  TotpSecretUnreadableError,
  TOTP_KEY_VERSION,
  type TotpKeyRing,
} from "../../src/lib/totp-secret-crypto";

const ACCOUNT = "acc_abc123";
const OTHER_ACCOUNT = "acc_def456";
const SECRET = new Uint8Array(20).fill(7);

const validKeyB64 = Buffer.from("k".repeat(32)).toString("base64");

/** A ring holding one freshly generated key — the shape of an unrotated tier. */
const loneRing = async (): Promise<TotpKeyRing> =>
  createTotpKeyRing(await generateEphemeralTotpEncryptionKey());

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

  it("applies the same 32-byte check to the PREVIOUS key", async () => {
    // Optional does not mean lenient. A previous key that is present but wrong
    // would otherwise stage a rotation that quietly verifies nothing.
    await expect(
      importTotpEncryptionKey(Buffer.from("k".repeat(31)).toString("base64"), {
        envName: "OSN_TOTP_ENCRYPTION_KEY_PREVIOUS",
      }),
    ).rejects.toThrow(/must decode to exactly 32 bytes/);
  });

  it("names the variable it was given, so a rotation blames the right secret", async () => {
    // Mid-rotation two secrets hold a key. A message naming the current one
    // when the previous one is at fault sends the operator to the wrong value
    // during the one procedure where that costs the most.
    //
    // Both assertions are the LENGTH message, because `Buffer.from` never
    // rejects base64 — it decodes what it can — so the length check is the only
    // one a bad value actually reaches. That is the module's own note, and it
    // is why the unparseable case below lands here too.
    await expect(
      importTotpEncryptionKey("!!!!", { envName: "OSN_TOTP_ENCRYPTION_KEY_PREVIOUS" }),
    ).rejects.toThrow(/^OSN_TOTP_ENCRYPTION_KEY_PREVIOUS must decode to exactly 32 bytes$/);
    await expect(importTotpEncryptionKey("!!!!")).rejects.toThrow(
      /^OSN_TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes$/,
    );
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
      importTotpEncryptionKey(Buffer.from("k".repeat(31)).toString("base64"), {
        onInvalidLength: (n) => {
          reported.push(n);
        },
      }),
    ).rejects.toThrow(/^OSN_TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes$/);
    expect(reported).toEqual([31]);
  });

  it("does not call onInvalidLength for a key of the right length", async () => {
    const reported: number[] = [];
    await importTotpEncryptionKey(validKeyB64, {
      onInvalidLength: (n) => {
        reported.push(n);
      },
    });
    expect(reported).toEqual([]);
  });
});

describe("the key ring", () => {
  it("puts a lone key at the base version, where every existing row is stamped", async () => {
    const key = await generateEphemeralTotpEncryptionKey();
    const ring = createTotpKeyRing(key);
    expect([...ring.keys()]).toEqual([TOTP_KEY_VERSION]);
    // The column's own default, so a row written before any of this existed
    // lands on the key the ring calls current.
    expect(TOTP_KEY_VERSION).toBe(1);
  });

  it("puts the PREVIOUS key at the base version and the current one above it", async () => {
    // The direction is the whole feature. Reversed, the previous key would sit
    // at a version no row carries — inert — and every new credential would be
    // written under the outgoing key, which destroys the lot on the day that
    // secret is deleted.
    const current = await generateEphemeralTotpEncryptionKey();
    const previous = await generateEphemeralTotpEncryptionKey();
    const ring = createTotpKeyRing(current, previous);

    expect([...ring.keys()].toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(ring.get(1)).toBe(previous);
    expect(ring.get(2)).toBe(current);
    expect(currentTotpKeyVersion(ring)).toBe(2);
  });

  it("refuses to name a current version for an empty ring", () => {
    // `Math.max()` of nothing is -Infinity, which would stamp rows with a
    // version nothing can ever look up. A Map is always truthy, so no
    // `key ? … : fail` check upstream would have caught it.
    expect(() => currentTotpKeyVersion(new Map())).toThrow(/No TOTP encryption key/);
  });
});

describe("encrypt / decrypt round trip", () => {
  it("recovers the exact secret", async () => {
    const ring = await loneRing();
    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    const back = await decryptTotpSecret(ring, ACCOUNT, {
      secretCiphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: encrypted.keyVersion,
    });
    expect(back.secret).toEqual(SECRET);
  });

  it("never stores the plaintext in the ciphertext", async () => {
    const ring = await loneRing();
    const { ciphertext } = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    expect(Buffer.from(ciphertext).includes(Buffer.from(SECRET))).toBe(false);
  });

  it("uses a fresh IV per encryption, so the same secret never repeats a ciphertext", async () => {
    const ring = await loneRing();
    const a = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    const b = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("stamps the current key version", async () => {
    const ring = await loneRing();
    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    expect(encrypted.keyVersion).toBe(TOTP_KEY_VERSION);
  });

  it("writes under the HIGHEST version present, never the previous key", async () => {
    // A `min`-picking bug round-trips perfectly against its own ring, so it is
    // only visible here: it would write every new credential under the key the
    // rotation exists to retire.
    const current = await generateEphemeralTotpEncryptionKey();
    const previous = await generateEphemeralTotpEncryptionKey();
    const ring = createTotpKeyRing(current, previous);

    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    expect(encrypted.keyVersion).toBe(2);

    // And it really is the CURRENT key's ciphertext: a ring holding only the
    // current key opens it; one holding only the previous key does not.
    await expect(
      decryptTotpSecret(createTotpKeyRing(current), ACCOUNT, {
        secretCiphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        keyVersion: encrypted.keyVersion,
      }),
    ).resolves.toMatchObject({ secret: SECRET });
    await expect(
      decryptTotpSecret(createTotpKeyRing(previous), ACCOUNT, {
        secretCiphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        keyVersion: encrypted.keyVersion,
      }),
    ).rejects.toBeInstanceOf(TotpSecretUnreadableError);
  });

  it("refuses to encrypt against an empty ring", async () => {
    await expect(encryptTotpSecret(new Map(), ACCOUNT, SECRET)).rejects.toThrow(
      /No TOTP encryption key/,
    );
  });
});

describe("a key demoted to PREVIOUS still opens its rows", () => {
  it("verifies a row written before the rotation, with nothing but the two secrets changed", async () => {
    // Issue #968's first "done when", walked the way an operator walks it: a
    // row is written under one key, and the service restarts with that key
    // moved to OSN_TOTP_ENCRYPTION_KEY_PREVIOUS and a new key installed as
    // OSN_TOTP_ENCRYPTION_KEY. Both rings come from `createTotpKeyRing`, the
    // factory `build-deps.ts` calls — hand-building the Maps here would test
    // the ReadonlyMap rather than the path the operator takes.
    const k1 = await generateEphemeralTotpEncryptionKey();
    const k2 = await generateEphemeralTotpEncryptionKey();

    const before = createTotpKeyRing(k1);
    const row = await encryptTotpSecret(before, ACCOUNT, SECRET);

    const after = createTotpKeyRing(k2, k1);
    const opened = await decryptTotpSecret(after, ACCOUNT, {
      secretCiphertext: row.ciphertext,
      iv: row.iv,
      keyVersion: row.keyVersion,
    });

    expect(opened.secret).toEqual(SECRET);
    // Opened by the previous key, which is how the caller knows to re-key it.
    expect(opened.keyVersion).toBe(1);
    expect(currentTotpKeyVersion(after)).toBe(2);
  });

  it("opens a row whose stamp names no configured key, and reports the key that worked", async () => {
    // The property the whole scheme rests on. A rotation is staged by two
    // secret writes with a gap between them, so a row's stamp and the key it is
    // really under can disagree; if the stamp selected the key, every row in
    // that gap would be refused.
    const k1 = await generateEphemeralTotpEncryptionKey();
    const k2 = await generateEphemeralTotpEncryptionKey();
    const row = await encryptTotpSecret(createTotpKeyRing(k1), ACCOUNT, SECRET);

    const opened = await decryptTotpSecret(createTotpKeyRing(k2, k1), ACCOUNT, {
      secretCiphertext: row.ciphertext,
      iv: row.iv,
      keyVersion: 99, // no such version exists in the ring
    });

    expect(opened.secret).toEqual(SECRET);
    expect(opened.keyVersion).toBe(1);
  });

  it("attributes a row to the NEWEST key that opens it", async () => {
    // A rotation's first step stages the outgoing key while the current secret
    // is unchanged, so for a while both slots hold the same key. Attributing
    // those rows to the lower slot would re-encrypt the whole population under
    // the key it is already using, for nothing, and tick the drain counter the
    // operator is watching while it did so.
    const k1 = await generateEphemeralTotpEncryptionKey();
    const sameTwice = createTotpKeyRing(k1, k1);
    const row = await encryptTotpSecret(createTotpKeyRing(k1), ACCOUNT, SECRET);

    const opened = await decryptTotpSecret(sameTwice, ACCOUNT, {
      secretCiphertext: row.ciphertext,
      iv: row.iv,
      keyVersion: row.keyVersion,
    });

    expect(opened.keyVersion).toBe(currentTotpKeyVersion(sameTwice));
  });

  it("still opens drained rows after the previous key is deleted", async () => {
    // The end of a rotation. `createTotpKeyRing(k2)` numbers the lone key 1,
    // while the drained rows are stamped 2 — so this passes only because the
    // stamp is a hint. It is the exact state that locked every user out under
    // the scheme this one replaced.
    const k1 = await generateEphemeralTotpEncryptionKey();
    const k2 = await generateEphemeralTotpEncryptionKey();
    const during = createTotpKeyRing(k2, k1);
    const drained = await encryptTotpSecret(during, ACCOUNT, SECRET);
    expect(drained.keyVersion).toBe(2);

    await expect(
      decryptTotpSecret(createTotpKeyRing(k2), ACCOUNT, {
        secretCiphertext: drained.ciphertext,
        iv: drained.iv,
        keyVersion: drained.keyVersion,
      }),
    ).resolves.toMatchObject({ secret: SECRET });
  });
});

describe("what the ring refuses", () => {
  /** Attempt a decrypt, so each test can assert on the rejection itself. */
  const attempt = (
    ring: TotpKeyRing,
    accountId: string,
    row: { ciphertext: Uint8Array; iv: Uint8Array; keyVersion: number },
  ) =>
    decryptTotpSecret(ring, accountId, {
      secretCiphertext: row.ciphertext,
      iv: row.iv,
      keyVersion: row.keyVersion,
    });

  it("refuses to decrypt a row moved to another account", async () => {
    // The whole point of the AAD: someone with write access to D1 cannot copy
    // a victim's credential row onto an account they control and then step up
    // with their own authenticator.
    const ring = await loneRing();
    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    await expect(attempt(ring, OTHER_ACCOUNT, encrypted)).rejects.toBeInstanceOf(
      TotpSecretUnreadableError,
    );
  });

  it("still refuses a moved row when two keys are live", async () => {
    // Trying a second key must not become a second chance to authenticate the
    // wrong account: every attempt binds the accountId as additional
    // authenticated data, so the fallback cannot launder a copied row.
    const k1 = await generateEphemeralTotpEncryptionKey();
    const k2 = await generateEphemeralTotpEncryptionKey();
    const encrypted = await encryptTotpSecret(createTotpKeyRing(k1), ACCOUNT, SECRET);
    await expect(
      attempt(createTotpKeyRing(k2, k1), OTHER_ACCOUNT, encrypted),
    ).rejects.toBeInstanceOf(TotpSecretUnreadableError);
  });

  it("refuses to decrypt under a ring that holds neither key", async () => {
    const ring = await loneRing();
    const other = await loneRing();
    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    await expect(attempt(other, ACCOUNT, encrypted)).rejects.toBeInstanceOf(
      TotpSecretUnreadableError,
    );
  });

  it("refuses a tampered ciphertext rather than returning plausible bytes", async () => {
    const ring = await loneRing();
    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    const tampered = new Uint8Array(encrypted.ciphertext);
    tampered[0] ^= 0xff;
    await expect(
      attempt(ring, ACCOUNT, { ...encrypted, ciphertext: tampered }),
    ).rejects.toBeInstanceOf(TotpSecretUnreadableError);
  });

  it("refuses an empty ring outright", async () => {
    const ring = await loneRing();
    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    await expect(attempt(new Map(), ACCOUNT, encrypted)).rejects.toBeInstanceOf(
      TotpSecretUnreadableError,
    );
  });

  it("says nothing about the ciphertext or the account in the error", async () => {
    const ring = await loneRing();
    const other = await loneRing();
    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);
    const error = await decryptTotpSecret(other, ACCOUNT, {
      secretCiphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: encrypted.keyVersion,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    // This message reaches a log line.
    expect(error).toBeInstanceOf(TotpSecretUnreadableError);
    expect(error?.message).not.toContain(Buffer.from(encrypted.ciphertext).toString("base64"));
    expect(error?.message).not.toContain(ACCOUNT);
  });
});

describe("the ceremony-store shape survives JSON", () => {
  // The in-memory ceremony store keeps the value by reference; the Redis one
  // round-trips it through JSON.stringify. A Uint8Array in the entry would pass
  // every test on the first and come back from Upstash as {"0":12,"1":200,…}.
  it("survives a stringify/parse cycle and still decrypts", async () => {
    const ring = await loneRing();
    const encrypted = await encryptTotpSecret(ring, ACCOUNT, SECRET);

    const throughJson = JSON.parse(JSON.stringify(toJsonSafe(encrypted))) as ReturnType<
      typeof toJsonSafe
    >;
    const back = await decryptTotpSecret(ring, ACCOUNT, fromJsonSafe(throughJson));

    expect(back.secret).toEqual(SECRET);
  });

  it("carries only JSON-native values", () => {
    const shape = toJsonSafe({ ciphertext: SECRET, iv: new Uint8Array(12), keyVersion: 1 });
    expect(typeof shape.ciphertextB64).toBe("string");
    expect(typeof shape.ivB64).toBe("string");
    expect(typeof shape.keyVersion).toBe("number");
  });
});
