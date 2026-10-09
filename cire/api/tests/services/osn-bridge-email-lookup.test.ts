import { afterEach, describe, expect, it } from "bun:test";

import { exportKeyToJwk, generateArcKeyPair } from "@shared/crypto/jwk";

import {
  createArcOrganiserEmailLookup,
  createOrganiserEmailLookupFromEnv,
} from "../../src/services/osn-bridge";
import { mockFetch } from "../test-helpers";

// The organiser address lookup says whether osn-api answered, apart from what
// it answered. The RSVP digest holds every recipient's marker when osn-api did
// not answer, and moves the marker of a recipient osn-api has no address for —
// so "down" and "no addresses" must not look the same.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function config() {
  const pair = await generateArcKeyPair();
  return { osnApiUrl: "https://osn.example/", arcPrivateKey: pair.privateKey, arcKeyId: "kid-1" };
}

const answer = (emails: { profile_id: string; email: string }[], status = 200) =>
  new Response(JSON.stringify({ emails }), { status });

describe("createArcOrganiserEmailLookup", () => {
  it("answers with the addresses osn-api returned, leaving out the ids it omitted", async () => {
    let body: unknown;
    globalThis.fetch = mockFetch(async (url, init) => {
      expect(String(url)).toBe("https://osn.example/internal/accounts/emails");
      body = JSON.parse(String(init?.body));
      return answer([{ profile_id: "usr_a", email: "a@example.test" }]);
    });
    const lookup = createArcOrganiserEmailLookup(await config());
    const result = await lookup(["usr_a", "usr_b", "usr_a"]);
    expect(result.answered).toBe(true);
    expect([...result.emails]).toEqual([["usr_a", "a@example.test"]]);
    expect(body).toEqual({ profile_ids: ["usr_a", "usr_b"] });
  });

  it("counts an empty list from osn-api as an answer", async () => {
    globalThis.fetch = mockFetch(async () => answer([]));
    const result = await createArcOrganiserEmailLookup(await config())(["usr_a"]);
    expect(result).toEqual({ answered: true, emails: new Map() });
  });

  it("says osn-api did not answer on an error status, a malformed body or a failed fetch", async () => {
    const lookup = createArcOrganiserEmailLookup(await config());
    globalThis.fetch = mockFetch(async () => answer([], 503));
    expect((await lookup(["usr_a"])).answered).toBe(false);
    globalThis.fetch = mockFetch(async () => new Response("{}", { status: 200 }));
    expect((await lookup(["usr_a"])).answered).toBe(false);
    globalThis.fetch = mockFetch(async () => new Response("not json", { status: 200 }));
    expect((await lookup(["usr_a"])).answered).toBe(false);
    globalThis.fetch = mockFetch(async () => {
      throw new Error("offline");
    });
    expect((await lookup(["usr_a"])).answered).toBe(false);
  });

  it("says osn-api did not answer when one chunk of several failed, and keeps what the others returned", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `usr_${i}`);
    let call = 0;
    globalThis.fetch = mockFetch(async () => {
      call += 1;
      return call === 1
        ? answer([{ profile_id: "usr_0", email: "0@example.test" }])
        : answer([], 500);
    });
    const result = await createArcOrganiserEmailLookup(await config())(ids);
    expect(result.answered).toBe(false);
    expect(result.emails.get("usr_0")).toBe("0@example.test");
  });

  it("asks nothing for no ids", async () => {
    globalThis.fetch = mockFetch(async () => {
      throw new Error("should not be called");
    });
    expect(await createArcOrganiserEmailLookup(await config())([])).toEqual({
      answered: true,
      emails: new Map(),
    });
  });
});

describe("createOrganiserEmailLookupFromEnv", () => {
  it("is null when any piece of the ARC config is missing or the key does not import", async () => {
    const jwk = await exportKeyToJwk((await generateArcKeyPair()).privateKey);
    expect(
      await createOrganiserEmailLookupFromEnv({ arcPrivateKeyJwk: jwk, arcKeyId: "k" }),
    ).toBeNull();
    expect(
      await createOrganiserEmailLookupFromEnv({
        osnApiUrl: "https://o",
        arcKeyId: "k",
        arcPrivateKeyJwk: "nope",
      }),
    ).toBeNull();
    expect(
      await createOrganiserEmailLookupFromEnv({
        osnApiUrl: "https://o",
        arcKeyId: "k",
        arcPrivateKeyJwk: jwk,
      }),
    ).not.toBeNull();
  });
});
