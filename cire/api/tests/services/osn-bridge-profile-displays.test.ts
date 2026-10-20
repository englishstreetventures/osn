import { afterEach, describe, expect, it } from "bun:test";

import { generateArcKeyPair } from "@shared/crypto/jwk";

import { createArcProfileDisplayResolver } from "../../src/services/osn-bridge";
import { mockFetch } from "../test-helpers";

// The co-host list hands each seat's photo URL to every member's browser, which
// loads it as an image. Only an https URL may reach the page: anything else
// osn-api sends is dropped here, and the portal draws initials instead.

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
  });
}

const answer = (profiles: Record<string, unknown>[]) =>
  new Response(JSON.stringify({ profiles }), { status: 200 });

describe("createArcProfileDisplayResolver", () => {
  it("keeps an https photo URL alongside the handle and display name", async () => {
    let asked: unknown;
    globalThis.fetch = mockFetch(async (url, init) => {
      expect(String(url)).toBe("https://osn.example/graph/internal/profile-displays");
      asked = JSON.parse(String(init?.body));
      return answer([
        {
          id: "usr_a",
          handle: "ada",
          displayName: "Ada",
          avatarUrl: "https://cdn.example/a.png",
        },
      ]);
    });
    const displays = await (await resolver())(["usr_a"]);
    expect(asked).toEqual({ profileIds: ["usr_a"] });
    expect(displays.get("usr_a")).toEqual({
      handle: "ada",
      displayName: "Ada",
      avatarUrl: "https://cdn.example/a.png",
    });
  });

  it("drops a photo URL that is not https, or not a URL at all, and keeps the person", async () => {
    const refused = [
      "http://cdn.example/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "//cdn.example/a.png",
      "not a url",
      "",
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
});
