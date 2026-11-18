/**
 * The browser Email Verification API verifier, against a stand-in issuer.
 * Every case but the first is a refusal the verifier must make; each one
 * names the outcome it is counted under. The first proves the stand-in's
 * token verifies, so a refusal below is the change it makes and nothing else.
 */

import { generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createIssuerNetwork,
  ISSUER_RESPONSE_MAX_BYTES,
} from "../../../src/services/auth/email-verification-network";
import {
  checkEmailVerificationToken,
  nonceOf,
  type CheckArgs,
} from "../../../src/services/auth/email-verification-token";
import { createServerMac } from "../../../src/services/auth/server-mac";
import {
  createFakeIssuer,
  joinedFetch,
  unsignedEvt,
  type FakeIssuer,
  type MintOptions,
} from "../../helpers/email-verification";

const AUDIENCE = "https://musubi.example";
const MINUTE = 60;
const serverMac = createServerMac("test-pepper-for-email-verification");

let issuer: FakeIssuer;
let email: string;

beforeEach(async () => {
  issuer = await createFakeIssuer();
  email = `ada@${issuer.domain}`;
});

/** A nonce secret as the route mints it, and the token's nonce for it. */
const freshNonce = () => {
  const nonceSecret = serverMac.mintEmailVerificationNonce(Date.now() + 10 * 60_000);
  return { nonceSecret, nonce: nonceOf(nonceSecret) };
};

async function check(
  mint: Partial<MintOptions> = {},
  args: Partial<CheckArgs> = {},
  fetch = issuer.fetch,
) {
  const { nonce, nonceSecret } = freshNonce();
  const token = await issuer.mint({ email, nonce, aud: AUDIENCE, ...mint });
  return checkEmailVerificationToken({
    emailVerificationToken: token,
    nonceSecret,
    email,
    audience: AUDIENCE,
    network: createIssuerNetwork(fetch),
    serverMac,
    now: Date.now(),
    signal: AbortSignal.timeout(5_000),
    ...args,
  });
}

const issuerRequests = () => issuer.requested.filter((url) => url.startsWith("https://issuer."));

describe("a token from the address's own issuer", () => {
  it("verifies, and names its nonce for the single-use claim", async () => {
    const result = await check();
    expect(result.outcome).toBe("verified");
    expect(result.claim?.key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("refusals", () => {
  it("refuses a token for another address", async () => {
    expect((await check({ email: `grace@${issuer.domain}` })).outcome).toBe("email");
  });

  it("refuses an EVT past its exp", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await check({ exp: now - 5 * MINUTE })).outcome).toBe("expired");
  });

  it("refuses a key binding issued more than ten minutes ago", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await check({ kbIat: now - 11 * MINUTE })).outcome).toBe("expired");
  });

  it("refuses an EVT signed by a key the issuer does not publish", async () => {
    const stranger = await generateKeyPair("Ed25519");
    expect((await check({ evtSigner: stranger.privateKey })).outcome).toBe("signature");
  });

  it("refuses a token bound to another origin", async () => {
    expect((await check({ aud: "https://evil.example" })).outcome).toBe("binding");
  });

  it("refuses a key binding signed by a key other than the one the EVT binds", async () => {
    const thief = await generateKeyPair("Ed25519");
    expect((await check({ kbSigner: thief.privateKey })).outcome).toBe("binding");
  });

  it("refuses a nonce secret this server did not mint", async () => {
    const forged = Buffer.alloc(56, 7).toString("base64url");
    expect((await check({ nonce: nonceOf(forged) }, { nonceSecret: forged })).outcome).toBe(
      "binding",
    );
  });

  it("refuses a nonce secret that is not the one the token is bound to", async () => {
    const other = freshNonce();
    expect((await check({}, { nonceSecret: other.nonceSecret })).outcome).toBe("binding");
  });

  it("refuses a token signed by another reachable issuer, whatever its iss says", async () => {
    // Issuer B is real and reachable, with its own DNS record and keys; the
    // address's DNS names issuer A. B's token for A's address is refused
    // whether it names itself or claims to be A.
    const other = await createFakeIssuer({
      domain: "other-mail.example",
      host: "issuer-b.example",
    });
    const both = joinedFetch(issuer, other);
    const { nonce, nonceSecret } = freshNonce();
    const base = { network: createIssuerNetwork(both), serverMac, audience: AUDIENCE };
    const run = (token: string) =>
      checkEmailVerificationToken({
        ...base,
        emailVerificationToken: token,
        nonceSecret,
        email,
        now: Date.now(),
        signal: AbortSignal.timeout(5_000),
      });

    const asItself = await other.mint({ email, nonce, aud: AUDIENCE });
    expect((await run(asItself)).outcome).toBe("issuer");
    const asA = await other.mint({
      email,
      nonce,
      aud: AUDIENCE,
      evtClaims: { iss: `https://${issuer.host}` },
    });
    expect((await run(asA)).outcome).toBe("signature");
  });

  it.each([
    ["127.0.0.1"],
    ["10.0.0.5"],
    ["169.254.169.254"],
    ["192.168.1.10"],
    ["100.64.0.1"],
    ["192.88.99.1"],
  ])("refuses an issuer that resolves to %s, and never sends it a request", async (address) => {
    issuer.dns.set(`A ${issuer.host}`, [address]);
    expect((await check()).outcome).toBe("issuer");
    expect(issuerRequests()).toEqual([]);
  });

  it.each([
    ["::1"],
    ["fd00::1"],
    ["fe80::1"],
    ["fec0::1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:0:7f00:1"],
    ["64:ff9b:1::a00:5"],
    ["2002:7f00:1::"],
  ])("refuses an issuer with an IPv6 answer of %s, whatever its IPv4 answers", async (address) => {
    issuer.dns.set(`AAAA ${issuer.host}`, [address]);
    expect((await check()).outcome).toBe("issuer");
    expect(issuerRequests()).toEqual([]);
  });

  it("refuses metadata that does not name its issuer", async () => {
    issuer.routes.set(`https://${issuer.host}/.well-known/email-verification`, () =>
      Response.json({ jwks_uri: `https://${issuer.host}/jwks` }),
    );
    expect((await check()).outcome).toBe("issuer");
    expect(issuer.requested).not.toContain(`https://${issuer.host}/jwks`);
  });

  it("gives up on an issuer that sends its headers and then stalls, when the time runs out", async () => {
    issuer.routes.set(
      `https://${issuer.host}/.well-known/email-verification`,
      () =>
        new Response(
          // One byte, then nothing: the stream neither ends nor errors.
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const started = Date.now();
    const result = await check({}, { signal: AbortSignal.timeout(200) });
    expect(result.outcome).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up on a network that never answers and ignores the abort, when the time runs out", async () => {
    const silent = (url: string, init: RequestInit) =>
      new URL(url).hostname === issuer.host
        ? new Promise<Response>(() => undefined)
        : issuer.fetch(url, init);
    const started = Date.now();
    const result = await check({}, { signal: AbortSignal.timeout(200) }, silent);
    expect(result.outcome).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses a non-https key URL, and never fetches it", async () => {
    issuer.routes.set(`https://${issuer.host}/.well-known/email-verification`, () =>
      Response.json({ issuer: `https://${issuer.host}`, jwks_uri: `http://${issuer.host}/jwks` }),
    );
    expect((await check()).outcome).toBe("issuer");
    expect(issuer.requested.some((url) => url.startsWith("http://"))).toBe(false);
  });

  it("refuses an oversized metadata document", async () => {
    const padding = "x".repeat(ISSUER_RESPONSE_MAX_BYTES + 1);
    issuer.routes.set(
      `https://${issuer.host}/.well-known/email-verification`,
      () =>
        new Response(
          JSON.stringify({ jwks_uri: `https://${issuer.host}/jwks`, padding }),
          // No Content-Length: the cap must hold on the bytes read.
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect((await check()).outcome).toBe("issuer");
  });

  it("refuses a redirect to another host, and never follows it", async () => {
    issuer.dns.set("A elsewhere.example", ["93.184.215.15"]);
    issuer.routes.set(
      `https://${issuer.host}/.well-known/email-verification`,
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/.well-known/email-verification" },
        }),
    );
    expect((await check()).outcome).toBe("issuer");
    expect(issuer.requested.some((url) => url.includes("elsewhere.example/"))).toBe(false);
  });

  it.each<[string, Partial<MintOptions>, string]>([
    ["a key binding over another EVT", { kbClaims: { sd_hash: "AAAA" } }, "binding"],
    ["email_verified false", { evtClaims: { email_verified: false } }, "malformed"],
    ["an EVT of another type", { evtHeader: { typ: "JWT" } }, "malformed"],
    [
      "a key binding issued in the future",
      { kbIat: Math.floor(Date.now() / 1000) + 5 * MINUTE },
      "expired",
    ],
  ])("refuses %s", async (_name, mint, outcome) => {
    expect((await check(mint)).outcome).toBe(outcome);
  });

  it("refuses an unsigned EVT", async () => {
    const { nonce, nonceSecret } = freshNonce();
    const token = unsignedEvt(await issuer.mint({ email, nonce, aud: AUDIENCE }));
    const result = await checkEmailVerificationToken({
      emailVerificationToken: token,
      nonceSecret,
      email,
      audience: AUDIENCE,
      network: createIssuerNetwork(issuer.fetch),
      serverMac,
      now: Date.now(),
      signal: AbortSignal.timeout(5_000),
    });
    expect(result.outcome).toBe("malformed");
  });

  it("refuses a domain with two issuer records", async () => {
    issuer.dns.set(`TXT _email-verification.${issuer.domain}`, [
      `"iss=${issuer.host}"`,
      '"iss=issuer-b.example"',
    ]);
    expect((await check()).outcome).toBe("issuer");
  });
});
