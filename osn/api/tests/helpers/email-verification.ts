/**
 * A stand-in mail provider for the browser Email Verification API: the DNS
 * record that names it, its metadata and keys, all behind one `fetch` the
 * verifier's network takes, and a mint that plays both the issuer (the EVT)
 * and the browser (the key-binding JWT), so a test can break any one part.
 */

import { createHash } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

import { DOH_ENDPOINT, type IssuerFetch } from "../../src/services/auth/email-verification-network";

const TYPES: Record<string, number> = { A: 1, TXT: 16, AAAA: 28 };

const b64url = (value: string): string => Buffer.from(value).toString("base64url");
const sha256 = (value: string): string => createHash("sha256").update(value).digest("base64url");

export interface FakeIssuer {
  /** The mail domain whose DNS names this issuer. */
  readonly domain: string;
  /** The issuer's host. */
  readonly host: string;
  /** Every URL the verifier asked for, in order. */
  readonly requested: string[];
  /** DNS answers by `<TYPE> <name>`: TXT as a resolver writes it (quoted), A/AAAA as addresses. */
  readonly dns: Map<string, string[]>;
  /** HTTPS answers by URL. */
  readonly routes: Map<string, () => Response>;
  readonly fetch: IssuerFetch;
  readonly issuerKey: CryptoKey;
  mint(options: MintOptions): Promise<string>;
}

export interface MintOptions {
  readonly email: string;
  readonly nonce: string;
  readonly aud: string;
  /** Seconds since the epoch; default now. */
  readonly evtIat?: number;
  readonly kbIat?: number;
  readonly exp?: number;
  /** Signs the EVT instead of the issuer's key. */
  readonly evtSigner?: CryptoKey;
  /** Signs the KB-JWT instead of the key the EVT binds. */
  readonly kbSigner?: CryptoKey;
  readonly evtHeader?: Record<string, unknown>;
  readonly evtClaims?: Record<string, unknown>;
  readonly kbClaims?: Record<string, unknown>;
}

/** Answers `fetch` with the routes of every issuer in `issuers`, the first one's DNS included. */
export function joinedFetch(...issuers: FakeIssuer[]): IssuerFetch {
  return async (url, init) => {
    for (const issuer of issuers) {
      const u = new URL(url);
      if (`${u.origin}${u.pathname}` === DOH_ENDPOINT || issuer.routes.has(url)) {
        return issuer.fetch(url, init);
      }
    }
    return new Response("not found", { status: 404 });
  };
}

export async function createFakeIssuer(
  options: { domain?: string; host?: string } = {},
): Promise<FakeIssuer> {
  const domain = options.domain ?? "mail.example";
  const host = options.host ?? "issuer.example";
  const keys = await generateKeyPair("Ed25519", { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "Ed25519" };

  const dns = new Map<string, string[]>([
    [`TXT _email-verification.${domain}`, [`"iss=${host}"`]],
    [`A ${host}`, ["93.184.215.14"]],
  ]);
  const routes = new Map<string, () => Response>([
    [
      `https://${host}/.well-known/email-verification`,
      () =>
        Response.json({
          issuer: `https://${host}`,
          issuance_endpoint: `https://${host}/issue`,
          jwks_uri: `https://${host}/jwks`,
          signing_alg_values_supported: ["Ed25519"],
        }),
    ],
    [`https://${host}/jwks`, () => Response.json({ keys: [publicJwk] })],
  ]);
  const requested: string[] = [];

  const fetch: IssuerFetch = async (url) => {
    requested.push(url);
    const u = new URL(url);
    if (`${u.origin}${u.pathname}` === DOH_ENDPOINT) {
      const name = u.searchParams.get("name") ?? "";
      const type = Number(u.searchParams.get("type"));
      const label = Object.keys(TYPES).find((k) => TYPES[k] === type) ?? "";
      const answers = dns.get(`${label} ${name}`) ?? [];
      return Response.json(
        { Status: 0, Answer: answers.map((data) => ({ name, type, TTL: 60, data })) },
        { headers: { "content-type": "application/dns-json" } },
      );
    }
    const route = routes.get(url);
    return route ? route() : new Response("not found", { status: 404 });
  };

  const mint = async (o: MintOptions): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const holder = await generateKeyPair("Ed25519", { extractable: true });
    const holderJwk = { ...(await exportJWK(holder.publicKey)), alg: "Ed25519" };
    const evtJwt = await new SignJWT({
      iss: `https://${host}`,
      iat: o.evtIat ?? now,
      ...(o.exp === undefined ? {} : { exp: o.exp }),
      cnf: { jwk: holderJwk },
      email: o.email,
      email_verified: true,
      ...o.evtClaims,
    })
      .setProtectedHeader({ alg: "Ed25519", kid: "k1", typ: "evt+jwt", ...o.evtHeader })
      .sign(o.evtSigner ?? keys.privateKey);
    const evt = `${evtJwt}~`;
    const kbJwt = await new SignJWT({
      aud: o.aud,
      nonce: o.nonce,
      iat: o.kbIat ?? now,
      sd_hash: sha256(evt),
      ...o.kbClaims,
    })
      .setProtectedHeader({ alg: "Ed25519", typ: "kb+jwt" })
      .sign(o.kbSigner ?? holder.privateKey);
    return `${evt}${kbJwt}`;
  };

  return {
    domain,
    host,
    requested,
    dns,
    routes,
    fetch,
    issuerKey: keys.privateKey,
    mint,
  };
}

/** A token whose EVT says `alg: none` and carries no signature. */
export function unsignedEvt(token: string): string {
  const [evtJwt, kb] = token.split("~") as [string, string];
  const [, payload] = evtJwt.split(".");
  return `${b64url(JSON.stringify({ alg: "none", typ: "evt+jwt" }))}.${payload}.~${kb}`;
}
