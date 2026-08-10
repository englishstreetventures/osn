import type { Db } from "@pulse/db/service";
import { makeAccessTokenSigner, type AccessTokenSigner } from "@shared/crypto/testing";
import { ManagedRuntime } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeCallerResolver, type ResolveCaller } from "../../src/lib/caller";
import { webSessionService, type WebIdentity } from "../../src/services/webSession";
import { createTestLayer } from "../helpers/db";

// The JWKS URL is never fetched: every verify path here is given `testKey`.
const JWKS_URL = "http://localhost:4000/.well-known/jwks.json";

const identity: WebIdentity = {
  osnProfileId: "usr_alice",
  osnSub: "pairwise-sub-for-pulse",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  avatarUrl: "https://cdn.example/a.png",
};

let signer: AccessTokenSigner;
let runtime: ManagedRuntime.ManagedRuntime<Db, never>;
let resolveCaller: ResolveCaller;

beforeAll(async () => {
  signer = await makeAccessTokenSigner();
});

beforeEach(() => {
  // Fresh in-memory DB per test — a leaked session row would make the
  // "bearer does not fall back" test pass for the wrong reason.
  runtime = ManagedRuntime.make(createTestLayer());
  resolveCaller = makeCallerResolver({
    runtime,
    jwksUrl: JWKS_URL,
    testKey: signer.publicKey,
  });
});

const mintCookieSession = async (over: Partial<WebIdentity> = {}): Promise<string> => {
  const created = await runtime.runPromise(webSessionService.create({ ...identity, ...over }));
  return `pulse_web_session=${created.token}`;
};

describe("makeCallerResolver", () => {
  it("resolves a bearer access token to its claims", async () => {
    const token = await signer.sign("usr_bob", { email: "bob@example.com" });
    const claims = await resolveCaller({ authorization: `Bearer ${token}` });
    expect(claims?.profileId).toBe("usr_bob");
    expect(claims?.email).toBe("bob@example.com");
  });

  it("resolves a session cookie to the profile id, not the pairwise sub", async () => {
    const cookie = await mintCookieSession();
    const claims = await resolveCaller({ cookie });
    // `osnSub` is pairwise and meaningless to the OSN graph; everything
    // downstream keys on the profile.
    expect(claims?.profileId).toBe("usr_alice");
    expect(claims?.profileId).not.toBe(identity.osnSub);
    expect(claims?.email).toBe("alice@example.com");
    expect(claims?.handle).toBe("alice");
    expect(claims?.displayName).toBe("Alice");
  });

  it("returns null with no credential at all", async () => {
    expect(await resolveCaller({})).toBeNull();
  });

  it("returns null for a cookie whose session was never issued", async () => {
    expect(await resolveCaller({ cookie: "pulse_web_session=never-issued" })).toBeNull();
  });

  it("returns null for an expired session cookie", async () => {
    const created = await runtime.runPromise(webSessionService.create(identity, -1));
    expect(await resolveCaller({ cookie: `pulse_web_session=${created.token}` })).toBeNull();
  });

  it("lets a bearer token decide the request outright — no cookie fallback", async () => {
    // A present-but-invalid Authorization header is a rejection, not an
    // invitation to answer as whoever the cookie names.
    const cookie = await mintCookieSession();
    const expired = await signer.sign("usr_bob", { expiresIn: "-120s" });

    expect(await resolveCaller({ authorization: `Bearer ${expired}`, cookie })).toBeNull();
    expect(await resolveCaller({ authorization: "Bearer garbage", cookie })).toBeNull();
    expect(await resolveCaller({ authorization: "Basic abc", cookie })).toBeNull();

    // The cookie alone still works — the null above is the header's doing.
    expect((await resolveCaller({ cookie }))?.profileId).toBe("usr_alice");
  });

  it("prefers a valid bearer token over a valid cookie for a different profile", async () => {
    const cookie = await mintCookieSession();
    const token = await signer.sign("usr_bob");
    expect((await resolveCaller({ authorization: `Bearer ${token}`, cookie }))?.profileId).toBe(
      "usr_bob",
    );
  });

  it("rejects a token minted for another audience", async () => {
    const token = await signer.sign("usr_bob", { audience: "osn-step-up" });
    expect(await resolveCaller({ authorization: `Bearer ${token}` })).toBeNull();
  });
});
