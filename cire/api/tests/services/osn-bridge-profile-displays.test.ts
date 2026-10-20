import { afterEach, describe, expect, it } from "bun:test";

import { exportKeyToJwk, generateArcKeyPair } from "@shared/crypto/jwk";

import {
  createArcProfileDisplayResolver,
  createProfileDisplayResolverFromEnv,
} from "../../src/services/osn-bridge";
import { mockFetch } from "../test-helpers";

// The co-host list hands each seat's photo URL to every member's browser, which
// loads it as an image, and the photo's host sees each reader's IP address.
// Only an https URL on one of musubi's own hosts may reach the page: anything
// else osn-api sends is dropped here, and the portal draws a default empty
// avatar instead.

/** musubi's identity host, the one place a photo may load from in these tests. */
const PHOTO_ORIGIN = "https://id.example";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function resolver() {
  const pair = await generateArcKeyPair();
  return createArcProfileDisplayResolver({
    osnApiUrl: "https://osn.example/",
    arcPrivateKey: pair.privateKey,
    arcKeyId: "kid-1",
    avatarOrigins: [PHOTO_ORIGIN],
  });
}

/** The photo URL each profile's display came back with, by id. */
async function photosFor(avatarUrls: unknown[]): Promise<(string | null)[]> {
  globalThis.fetch = mockFetch(async () =>
    answer(avatarUrls.map((avatarUrl, i) => ({ id: `usr_${i}`, handle: `h${i}`, avatarUrl }))),
  );
  const displays = await (await resolver())(avatarUrls.map((_, i) => `usr_${i}`));
  expect(displays.size).toBe(avatarUrls.length);
  return avatarUrls.map((_, i) => displays.get(`usr_${i}`)!.avatarUrl);
}

const answer = (profiles: Record<string, unknown>[]) =>
  new Response(JSON.stringify({ profiles }), { status: 200 });

describe("createArcProfileDisplayResolver", () => {
  it("keeps an https photo URL on musubi's host alongside the handle and display name", async () => {
    let asked: unknown;
    globalThis.fetch = mockFetch(async (url, init) => {
      expect(String(url)).toBe("https://osn.example/graph/internal/profile-displays");
      asked = JSON.parse(String(init?.body));
      return answer([
        {
          id: "usr_a",
          handle: "ada",
          displayName: "Ada",
          avatarUrl: `${PHOTO_ORIGIN}/a.png`,
        },
      ]);
    });
    const displays = await (await resolver())(["usr_a"]);
    expect(asked).toEqual({ profileIds: ["usr_a"] });
    expect(displays.get("usr_a")).toEqual({
      handle: "ada",
      displayName: "Ada",
      avatarUrl: `${PHOTO_ORIGIN}/a.png`,
    });
  });

  it("drops a photo URL that is not https, or not a URL at all, and keeps the person", async () => {
    const refused = [
      "http://id.example/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "//cdn.example/a.png",
      "not a url",
      "",
      // An array of one URL stringifies to that URL, so only the type check
      // keeps it out.
      [`${PHOTO_ORIGIN}/a.png`],
      42,
      null,
      undefined,
    ];
    globalThis.fetch = mockFetch(async () =>
      answer(refused.map((avatarUrl, i) => ({ id: `usr_${i}`, handle: `h${i}`, avatarUrl }))),
    );
    const displays = await (await resolver())(refused.map((_, i) => `usr_${i}`));
    expect(displays.size).toBe(refused.length);
    for (const [id, display] of displays) {
      expect({ id, avatarUrl: display.avatarUrl }).toEqual({ id, avatarUrl: null });
    }
  });

  it("drops an https photo URL on any host but musubi's", async () => {
    expect(
      await photosFor([
        "https://cdn.example/a.png",
        "https://203.0.113.9/a.png",
        "https://[2001:db8::1]/a.png",
        "https://id.example.evil.test/a.png",
        "https://evil.test/https://id.example/a.png",
        // Same host, another port: another origin.
        "https://id.example:8443/a.png",
      ]),
    ).toEqual([null, null, null, null, null, null]);
  });

  it("drops a photo URL that carries a user name or password, even on musubi's host", async () => {
    expect(
      await photosFor([
        "https://user:secret@id.example/a.png",
        "https://user@id.example/a.png",
        "https://:secret@id.example/a.png",
      ]),
    ).toEqual([null, null, null]);
  });

  it("keeps a photo URL of 2048 characters and drops a longer one", async () => {
    const at = (length: number) => {
      const head = `${PHOTO_ORIGIN}/`;
      return head + "a".repeat(length - head.length);
    };
    expect(await photosFor([at(2048), at(2049)])).toEqual([at(2048), null]);
  });

  it("drops an http photo URL even on an allowed http origin, as a local issuer's is", async () => {
    const pair = await generateArcKeyPair();
    const local = createArcProfileDisplayResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: pair.privateKey,
      arcKeyId: "kid-1",
      avatarOrigins: ["http://localhost:4000"],
    });
    globalThis.fetch = mockFetch(async () =>
      answer([{ id: "usr_a", handle: "ada", avatarUrl: "http://localhost:4000/a.png" }]),
    );
    expect((await local(["usr_a"])).get("usr_a")?.avatarUrl).toBeNull();
  });

  it("drops every photo when no host is allowed", async () => {
    const pair = await generateArcKeyPair();
    const none = createArcProfileDisplayResolver({
      osnApiUrl: "https://osn.example/",
      arcPrivateKey: pair.privateKey,
      arcKeyId: "kid-1",
      avatarOrigins: [],
    });
    globalThis.fetch = mockFetch(async () =>
      answer([{ id: "usr_a", handle: "ada", avatarUrl: `${PHOTO_ORIGIN}/a.png` }]),
    );
    expect((await none(["usr_a"])).get("usr_a")?.avatarUrl).toBeNull();
  });
});

describe("createProfileDisplayResolverFromEnv", () => {
  it("allows photos from the OSN issuer's origin and no other", async () => {
    const jwk = await exportKeyToJwk((await generateArcKeyPair()).privateKey);
    const resolve = await createProfileDisplayResolverFromEnv({
      osnApiUrl: "https://osn.example/",
      osnIssuerUrl: `${PHOTO_ORIGIN}/`,
      arcPrivateKeyJwk: jwk,
      arcKeyId: "kid-env",
    });
    globalThis.fetch = mockFetch(async () =>
      answer([
        { id: "usr_a", handle: "a", avatarUrl: `${PHOTO_ORIGIN}/a.png` },
        { id: "usr_b", handle: "b", avatarUrl: "https://osn.example/b.png" },
      ]),
    );
    const displays = await resolve!(["usr_a", "usr_b"]);
    expect(displays.get("usr_a")?.avatarUrl).toBe(`${PHOTO_ORIGIN}/a.png`);
    expect(displays.get("usr_b")?.avatarUrl).toBeNull();
  });

  it("allows no photo when the issuer URL is missing or does not parse", async () => {
    const jwk = await exportKeyToJwk((await generateArcKeyPair()).privateKey);
    for (const osnIssuerUrl of [undefined, "not a url"]) {
      const resolve = await createProfileDisplayResolverFromEnv({
        osnApiUrl: "https://osn.example/",
        osnIssuerUrl,
        arcPrivateKeyJwk: jwk,
        arcKeyId: "kid-env",
      });
      globalThis.fetch = mockFetch(async () =>
        answer([{ id: "usr_a", handle: "a", avatarUrl: `${PHOTO_ORIGIN}/a.png` }]),
      );
      expect((await resolve!(["usr_a"])).get("usr_a")?.avatarUrl, String(osnIssuerUrl)).toBeNull();
    }
  });
});
