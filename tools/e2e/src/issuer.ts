/**
 * A stand-in mail provider for the browser Email Verification API, so the
 * stack's second osn-api (`osnApiEvt`) runs its real verifier against an
 * issuer it can reach.
 *
 * That osn-api sends every verifier request here
 * (`OSN_EMAIL_VERIFICATION_EMULATOR_URL`, read by `osn/api/src/build-deps.ts`)
 * as `/<host><path><query>`: the DNS-over-HTTPS resolver's queries, then the
 * issuer's metadata and keys. This server answers them for `EVT_ISSUER`: one
 * `_email-verification` TXT record naming the issuer host, an address for the
 * host, the metadata document and a JSON Web Key Set of one Ed25519 key.
 *
 * `POST /__e2e/evt` with `{ email, nonce, aud }` plays both parts the person's
 * mail provider and browser would: it signs an EVT for `email` with the
 * issuer's key, binding a fresh browser key, and a key-binding JWT for `aud`
 * and `nonce` with that browser key, and answers `{ token }`, the value a
 * browser with the API puts in the sign-up form's hidden field.
 *
 * Tokens are stamped on the suite's clock, which osn-api reads, not this
 * process's.
 */

import { EVT_ISSUER } from "./config";

const b64url = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString(
    "base64url",
  );

const sha256 = async (text: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

/** A JWT header or claim set: what this stand-in writes, and nothing else. */
interface JwtPart {
  readonly [name: string]: string | number | boolean | JwtPart;
}

async function sign(header: JwtPart, payload: JwtPart, key: CryptoKey): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

/** An Ed25519 public key's JWK members, as the JWKS and `cnf` carry them. */
async function publicJwk(key: CryptoKey): Promise<{ kty: string; crv: string; x: string }> {
  const { kty = "", crv = "", x = "" } = await crypto.subtle.exportKey("jwk", key);
  return { kty, crv, x };
}

const newKeyPair = () =>
  crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

/** A DNS-over-HTTPS JSON answer, as Cloudflare's resolver writes one. */
function dohAnswer(name: string, type: number, data: string[]): Response {
  return Response.json(
    { Status: 0, Answer: data.map((d) => ({ name, type, TTL: 300, data: d })) },
    { headers: { "content-type": "application/dns-json" } },
  );
}

export interface IssuerServer {
  readonly port: number;
  stop(): Promise<void>;
}

/** `suiteNow` is the suite clock in epoch ms: `CLOCK_T0` plus the real time since the run began. */
export async function startIssuerServer(
  port: number,
  suiteNow: () => number,
): Promise<IssuerServer> {
  const { domain, host, address } = EVT_ISSUER;
  const issuer = `https://${host}`;
  const keys = await newKeyPair();
  const jwk = { ...(await publicJwk(keys.publicKey)), kid: "e2e-1", alg: "Ed25519" };

  const mint = async (email: string, nonce: string, aud: string): Promise<string> => {
    const now = Math.floor(suiteNow() / 1000);
    const holder = await newKeyPair();
    const holderJwk = await publicJwk(holder.publicKey);
    const evtJwt = await sign(
      { alg: "Ed25519", kid: "e2e-1", typ: "evt+jwt" },
      {
        iss: issuer,
        iat: now,
        cnf: { jwk: { ...holderJwk, alg: "Ed25519" } },
        email,
        email_verified: true,
      },
      keys.privateKey,
    );
    const evt = `${evtJwt}~`;
    const kb = await sign(
      { alg: "Ed25519", typ: "kb+jwt" },
      { aud, nonce, iat: now, sd_hash: await sha256(evt) },
      holder.privateKey,
    );
    return `${evt}${kb}`;
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/cloudflare-dns.com/dns-query") {
        const name = url.searchParams.get("name") ?? "";
        const type = Number(url.searchParams.get("type"));
        if (type === 16 && name === `_email-verification.${domain}`) {
          return dohAnswer(name, type, [`"iss=${host}"`]);
        }
        if (type === 1 && name === host) return dohAnswer(name, type, [address]);
        return dohAnswer(name, type, []);
      }
      if (url.pathname === `/${host}/.well-known/email-verification`) {
        return Response.json({
          issuer,
          issuance_endpoint: `${issuer}/issue`,
          jwks_uri: `${issuer}/jwks`,
          signing_alg_values_supported: ["Ed25519"],
        });
      }
      if (url.pathname === `/${host}/jwks`) return Response.json({ keys: [jwk] });
      if (request.method === "POST" && url.pathname === "/__e2e/evt") {
        const { email, nonce, aud } = (await request.json()) as Record<string, string | undefined>;
        if (!email || !nonce || !aud) return new Response("email, nonce and aud", { status: 400 });
        return Response.json({ token: await mint(email, nonce, aud) });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return { port: server.port ?? port, stop: () => server.stop(true) };
}
