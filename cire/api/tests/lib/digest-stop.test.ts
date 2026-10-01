import { describe, expect, it } from "bun:test";

import {
  deriveDigestStopKey,
  digestStopUrl,
  signDigestStopToken,
  verifyDigestStopToken,
} from "../../src/lib/digest-stop";

const target = { weddingId: "wed_1", osnProfileId: "usr_ama" };

describe("digest stop tokens", () => {
  it("verify to the person and wedding they were signed for", async () => {
    const key = await deriveDigestStopKey("client-secret");
    const token = await signDigestStopToken(key, target);
    expect(await verifyDigestStopToken(key, token)).toEqual(target);
  });

  it("do not verify under a key from another secret", async () => {
    const token = await signDigestStopToken(await deriveDigestStopKey("client-secret"), target);
    const other = await deriveDigestStopKey("rotated-secret");
    expect(await verifyDigestStopToken(other, token)).toBeNull();
  });

  it("refuse a payload changed to name someone else", async () => {
    const key = await deriveDigestStopKey("client-secret");
    const [, mac] = (await signDigestStopToken(key, target)).split(".");
    const forged = btoa("v1\nwed_1\nusr_jonah")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(await verifyDigestStopToken(key, `${forged}.${mac}`)).toBeNull();
  });

  it.each(["", "abc", "a.b.c", "!!!.???", "x".repeat(600)])(
    "refuse a malformed token (%#)",
    async (token) => {
      const key = await deriveDigestStopKey("client-secret");
      expect(await verifyDigestStopToken(key, token)).toBeNull();
    },
  );

  it("build a link on the API origin that carries the token intact", async () => {
    const key = await deriveDigestStopKey("client-secret");
    const url = new URL(await digestStopUrl("https://api.example.test/", key, target));
    expect(url.origin + url.pathname).toBe("https://api.example.test/api/rsvp-digest/stop");
    expect(await verifyDigestStopToken(key, url.searchParams.get("t") ?? "")).toEqual(target);
  });
});
