/**
 * The verifier for a browser Email Verification API token sent with a
 * sign-up. The browser asks the address's mail provider (the issuer) to vouch
 * that the person controls the address, and fills a hidden form field with the
 * result: `<EVT>~<KB-JWT>`. The EVT is the issuer's signed statement of the
 * address and of a key the browser holds; the KB-JWT is signed with that key
 * and binds the EVT to our origin and to a nonce this service minted for the
 * tab. Follows the WICG proposal (`WICG/email-verification`, `index.bs` at
 * 2026-10-02) and the protocol draft it defers to,
 * `draft-hardt-email-verification-02` (2026-08-25); the wiki page
 * `email-verification-api` records what was read, and where this departs.
 *
 * A token is accepted only when all of these hold:
 *
 *  - two parts, EVT and KB-JWT, and nothing between them;
 *  - the nonce secret the tab presents was minted here, is unexpired, and
 *    hashes to the KB-JWT's `nonce`; it is used once (the caller claims it);
 *  - the KB-JWT's `aud` is the sign-up origin, its `sd_hash` is the EVT's
 *    hash, and its signature verifies under the EVT's `cnf.jwk`;
 *  - the EVT's `email` is the sign-up address (ASCII, compared lowercased),
 *    `email_verified` is true, and both `iat`s and any `exp` are in range;
 *  - the issuer is found from the sign-up address's own domain — one DNS TXT
 *    record `_email-verification.<domain>` naming `iss=<host>` — never from
 *    the token; the EVT's `iss` and the metadata's `issuer` name that host,
 *    and a key from the jwks_uri of that host's metadata verifies the EVT;
 *  - the whole check, lookups included, ends within its time budget.
 *
 * Every refusal is an outcome, never an error: the caller takes the emailed
 * link path for all of them, and the person sees nothing.
 */

import { createHash } from "node:crypto";

import type { EmailVerificationTokenOutcome } from "@shared/observability/metrics";
import { Effect } from "effect";
import { compactVerify, importJWK, type JWK } from "jose";

import { metricEmailVerificationToken } from "../../metrics";
import type { AuthContext } from "./context";
import {
  IssuerLookupError,
  isJsonObject,
  isLookupHost,
  parseJson,
  untilAborted,
  type IssuerNetwork,
  type JsonObject,
  type JsonValue,
} from "./email-verification-network";
import { frontendOrigin } from "./helpers";
import type { ServerMac } from "./server-mac";
import { storeCall } from "./store-call";

/** The longest token read. A real one is about a kilobyte. */
export const EMAIL_VERIFICATION_TOKEN_MAX = 8192;
/** A nonce's life, and how old an `iat` may be. */
export const EMAIL_VERIFICATION_WINDOW_MS = 10 * 60_000;
/** How far ahead of this clock an `iat` may be, and how far past an `exp`. */
export const EMAIL_VERIFICATION_SKEW_MS = 60_000;
/** The whole verification's time limit, lookups included. */
export const EMAIL_VERIFICATION_BUDGET_MS = 5_000;
/** The most issuer keys tried for one token. */
const MAX_KEYS_TRIED = 10;

/**
 * What the sign-up tab sends with its begin. Both keys are on the log
 * redaction deny-list, so either object is safe to pass to a logger whole.
 */
export interface EmailVerificationInput {
  /** The hidden field's value: `<EVT>~<KB-JWT>`. */
  readonly emailVerificationToken: string;
  /** What the nonce route gave the tab; the form's nonce is its hash. */
  readonly nonceSecret: string;
}

/** A nonce for the sign-up form, and the secret the tab keeps. */
export interface EmailVerificationNonce {
  readonly nonce: string;
  readonly nonceSecret: string;
}

/** What one check found; `claim` is what the caller claims, once, for a verified token. */
export interface CheckedToken {
  readonly outcome: EmailVerificationTokenOutcome;
  readonly claim?: { readonly key: string; readonly ttlMs: number };
}

const refused = (outcome: EmailVerificationTokenOutcome): CheckedToken => ({ outcome });

const b64urlSha256 = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

/** The form's nonce for a nonce secret: its SHA-256, base64url. */
export const nonceOf = (nonceSecret: string): string => b64urlSha256(nonceSecret);

const ASCII_EMAIL_RE = /^[\x21-\x3f\x41-\x7e]+@[a-z0-9.-]+$/i;

/** The JWS algorithms a key of this type and curve verifies, as jose names them. */
function algorithmsFor(jwk: JsonObject): readonly string[] {
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return ["Ed25519", "EdDSA"];
  if (jwk.kty === "EC" && jwk.crv === "P-256") return ["ES256"];
  return [];
}

const stringOf = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Verifies `jws` under `jwk` with `alg`, which must suit the key. The key's
 * own `alg` member, when present, must name the same operation (`EdDSA` and
 * `Ed25519` are one operation). Only the public members are imported.
 */
async function verifiesUnder(jws: string, jwk: JsonObject, alg: string): Promise<boolean> {
  const suits = algorithmsFor(jwk);
  if (!suits.includes(alg)) return false;
  const keyAlg = stringOf(jwk.alg);
  if (keyAlg !== undefined && !suits.includes(keyAlg)) return false;
  const publicKey: JWK = { kty: stringOf(jwk.kty), crv: stringOf(jwk.crv), x: stringOf(jwk.x) };
  const y = stringOf(jwk.y);
  if (y !== undefined) publicKey.y = y;
  try {
    const key = await importJWK(publicKey, alg);
    await compactVerify(jws, key, { algorithms: [alg] });
    return true;
  } catch {
    return false;
  }
}

/** Whether `iat` (seconds) is within the window and not ahead of the skew. */
const iatInRange = (iat: JsonValue | undefined, now: number): boolean =>
  typeof iat === "number" &&
  Number.isFinite(iat) &&
  iat * 1000 <= now + EMAIL_VERIFICATION_SKEW_MS &&
  iat * 1000 >= now - EMAIL_VERIFICATION_WINDOW_MS;

/** One base64url JSON segment of a JWT, or null. */
const segment = (part: string | undefined): JsonObject | null => {
  if (!part) return null;
  try {
    const value = parseJson(Buffer.from(part, "base64url").toString("utf8"));
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
};

/** A compact JWT's header and payload, unverified, or null when it is not one. */
const decode = (jwt: string): { header: JsonObject; payload: JsonObject } | null => {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const header = segment(parts[0]);
  const payload = segment(parts[1]);
  return header && payload ? { header, payload } : null;
};

export interface CheckArgs extends EmailVerificationInput {
  /** The sign-up address, lowercased. */
  readonly email: string;
  /** The origin the browser bound the token to: the sign-up page's. */
  readonly audience: string;
  readonly network: IssuerNetwork;
  readonly serverMac: ServerMac;
  readonly now: number;
  readonly signal: AbortSignal;
}

/**
 * The keys of the issuer that `domain`'s one `iss=` TXT record names, after
 * checking the EVT's `iss` and the metadata's `issuer` name that same issuer.
 * Throws {@link IssuerLookupError} for every refusal.
 */
async function issuerKeys(
  domain: string,
  iss: string,
  network: IssuerNetwork,
  signal: AbortSignal,
): Promise<JsonObject[]> {
  const records = (await network.txt(`_email-verification.${domain}`, signal)).filter((r) =>
    r.startsWith("iss="),
  );
  if (records.length !== 1) throw new IssuerLookupError("issuer", "not one issuer record");
  const host = records[0]!.slice("iss=".length).trim().toLowerCase();
  if (!isLookupHost(host)) throw new IssuerLookupError("issuer", "record names no host");
  const issuer = `https://${host}`;
  // The draft's identifier is the origin; earlier deployments used the host.
  if (iss !== issuer && iss !== host) throw new IssuerLookupError("issuer", "token names another");
  const metadata = await network.json(`${issuer}/.well-known/email-verification`, signal);
  if (metadata.issuer !== issuer) throw new IssuerLookupError("issuer", "metadata names another");
  if (typeof metadata.jwks_uri !== "string") throw new IssuerLookupError("issuer", "no jwks_uri");
  const jwks = await network.json(metadata.jwks_uri, signal);
  if (!Array.isArray(jwks.keys)) throw new IssuerLookupError("issuer", "no key set");
  return jwks.keys.filter(isJsonObject);
}

/**
 * Checks a token. Local checks run first, so a token that fails one costs no
 * lookup. The lookups end when `signal` aborts, whether or not the network
 * answers. Every refusal is an outcome; nothing here throws.
 */
export async function checkEmailVerificationToken(args: CheckArgs): Promise<CheckedToken> {
  const { emailVerificationToken: token, nonceSecret, email, audience, network } = args;
  const { serverMac, now, signal } = args;

  if (token.length === 0 || token.length > EMAIL_VERIFICATION_TOKEN_MAX) {
    return refused("malformed");
  }
  // `<EVT>~<KB-JWT>`: the EVT keeps SD-JWT's trailing `~`, and nothing may
  // sit between the two (no selective disclosures).
  const parts = token.split("~");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return refused("malformed");
  const [evtJwt = "", kbJwt = ""] = parts;
  const evt = decode(evtJwt);
  const kb = decode(kbJwt);
  if (!evt || !kb) return refused("malformed");

  const evtAlg = evt.header.alg;
  if (typeof evtAlg !== "string" || !["Ed25519", "EdDSA", "ES256"].includes(evtAlg)) {
    return refused("malformed");
  }
  // `evt+jwt` is the drafts' value; the WICG explainer's example carries
  // `evp-sd-jwt`. Either names this token type, and nothing else is read.
  if (evt.header.typ !== "evt+jwt" && evt.header.typ !== "evp-sd-jwt") return refused("malformed");
  if (kb.header.typ !== "kb+jwt" || typeof kb.header.alg !== "string") return refused("malformed");
  const claims = evt.payload;
  const cnf = isJsonObject(claims.cnf) && isJsonObject(claims.cnf.jwk) ? claims.cnf.jwk : null;
  if (
    typeof claims.iss !== "string" ||
    typeof claims.email !== "string" ||
    claims.email_verified !== true ||
    cnf === null
  ) {
    return refused("malformed");
  }

  // The address: the sign-up's own, ASCII only, so no case folding can turn
  // one address into another. The token's must be the same.
  if (!ASCII_EMAIL_RE.test(email) || !ASCII_EMAIL_RE.test(claims.email)) return refused("email");
  if (claims.email.toLowerCase() !== email) return refused("email");

  // The nonce: minted here for the tab, unexpired, and the one in the binding.
  const opened = serverMac.openEmailVerificationNonce(nonceSecret, now);
  if (!opened.ok) return refused(opened.reason === "expired" ? "expired" : "binding");
  const binding = kb.payload;
  if (binding.aud !== audience) return refused("binding");
  if (binding.nonce !== nonceOf(nonceSecret)) return refused("binding");
  if (binding.sd_hash !== b64urlSha256(`${evtJwt}~`)) return refused("binding");

  if (!iatInRange(claims.iat, now) || !iatInRange(binding.iat, now)) return refused("expired");
  if (claims.exp !== undefined) {
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now - EMAIL_VERIFICATION_SKEW_MS) {
      return refused("expired");
    }
  }

  // The holder: the KB-JWT is signed by the key the issuer bound into the EVT.
  if (!(await verifiesUnder(kbJwt, cnf, kb.header.alg))) return refused("binding");

  // The issuer: found from the address's domain, never from the token.
  const domain = email.slice(email.lastIndexOf("@") + 1);
  let keys: JsonObject[];
  try {
    keys = await untilAborted(issuerKeys(domain, claims.iss, network, signal), signal);
  } catch (e) {
    return refused(e instanceof IssuerLookupError ? e.outcome : "unavailable");
  }

  // A `kid` picks its key; without one (Gmail sends none) each key is tried.
  const kid = evt.header.kid;
  const candidates = (typeof kid === "string" ? keys.filter((k) => k.kid === kid) : keys).slice(
    0,
    MAX_KEYS_TRIED,
  );
  let signed = false;
  for (const key of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- stops at the first key that verifies
    if (await verifiesUnder(evtJwt, key, evtAlg)) {
      signed = true;
      break;
    }
  }
  if (!signed) return refused("signature");

  return {
    outcome: "verified",
    // The nonce is used once: claimed for the rest of its life and the skew.
    claim: {
      key: opened.nonce,
      ttlMs: Math.max(1, opened.expiresAt - now) + EMAIL_VERIFICATION_SKEW_MS,
    },
  };
}

export function createEmailVerificationModule(ctx: AuthContext) {
  const { config, serverMac, nonceClaims } = ctx;

  /** A nonce for the sign-up form, or null when the flag is off. */
  const mintNonce = (): EmailVerificationNonce | null => {
    if (!config.emailVerification) return null;
    const nonceSecret = serverMac.mintEmailVerificationNonce(
      Date.now() + EMAIL_VERIFICATION_WINDOW_MS,
    );
    return { nonce: nonceOf(nonceSecret), nonceSecret };
  };

  /**
   * Whether `input` proves the person controls `email` (lowercased). False,
   * with nothing said, for every refusal, and always while the flag is off.
   * Counted on `osn.auth.email_verification.tokens{outcome}`; never logged.
   */
  const verify = (email: string, input: EmailVerificationInput): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const settings = config.emailVerification;
      if (!settings) return false;
      const budget = AbortSignal.timeout(EMAIL_VERIFICATION_BUDGET_MS);
      const checked = yield* Effect.promise(() =>
        untilAborted(
          checkEmailVerificationToken({
            emailVerificationToken: input.emailVerificationToken,
            nonceSecret: input.nonceSecret,
            email,
            audience: frontendOrigin(config),
            network: settings.network,
            serverMac,
            now: Date.now(),
            signal: budget,
          }),
          budget,
        ).catch((): CheckedToken => refused("unavailable")),
      );
      let outcome = checked.outcome;
      if (outcome === "verified" && checked.claim) {
        const { key, ttlMs } = checked.claim;
        const won = yield* storeCall(nonceClaims, "claim", () =>
          nonceClaims.claim(key, ttlMs),
        ).pipe(Effect.catch(() => Effect.succeed(null)));
        outcome = won === true ? "verified" : won === false ? "replayed" : "unavailable";
      }
      metricEmailVerificationToken(outcome);
      return outcome === "verified";
    }).pipe(Effect.withSpan("auth.email_verification.verify"));

  return { mintNonce, verify };
}

export type EmailVerificationModule = ReturnType<typeof createEmailVerificationModule>;
