/**
 * Outbound ARC tokens for osn-api: the deletion preview and fan-out, the
 * session end at soft delete, and the account export all call apps with
 * them.
 *
 * Each isolate mints its own ES256 key pair and, before it signs anything
 * with it, writes the public half to `arc_outbound_keys`, which
 * `GET /.well-known/arc-jwks.json` serves. Apps verify osn-api's tokens
 * against that set (`@shared/osn-auth-client/arc`), so a key written by any
 * isolate verifies at any app isolate, with no registration call to each app.
 * The kid carries the key's expiry and an HMAC under `INTERNAL_SERVICE_SECRET`
 * (`@shared/crypto/arc-kid`), so an app refuses a made-up kid before it
 * fetches the set.
 *
 * {@link publishOutboundKey} answers the key it published, and every
 * signature is made with that key ({@link arcAuthHeader}), never with
 * whichever key the isolate holds by then: a key replaced in between is
 * still in the set. A key is replaced two hours before its expiry; the next
 * publish writes the new one. Nothing signs with a key past its expiry, and a
 * token lives five minutes, so apps need not re-check a key's expiry
 * themselves.
 */
import { arcOutboundKeys } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { exportKeyToJwk, generateArcKeyPair, getOrCreateArcToken } from "@shared/crypto";
import { arcKidMacSecret, mintArcKid } from "@shared/crypto/arc-kid";
import { commitBatch } from "@shared/db-utils";
import { gt, lt } from "drizzle-orm";
import { Data, Effect } from "effect";

/** osn-api's issuer id on every ARC token it signs; apps pin it. */
const OSN_ARC_ISSUER = "osn-api";

/** A key's life, and how long before its end it is replaced. */
const KEY_TTL_SECONDS = 24 * 3_600;
const KEY_ROTATION_BUFFER_SECONDS = 2 * 3_600;

/** How long after expiry a row stays before a publish deletes it. */
const EXPIRED_KEY_GRACE_SECONDS = 86_400;

/** What signing needs from the deployment. */
export interface OutboundArcConfig {
  /**
   * `INTERNAL_SERVICE_SECRET`: the kid MAC key. Unset only on a local run. A
   * value shorter than 32 characters keys no MAC (`@shared/crypto/arc-kid`).
   */
  readonly kidSecret: string | undefined;
}

/** Writing the key's public half failed; nothing may be signed with it yet. */
export class OutboundKeyPublishError extends Data.TaggedError("OutboundKeyPublishError")<{
  readonly cause: unknown;
}> {}

/** A signature was asked for with a key {@link publishOutboundKey} did not answer: a bug in the caller. */
export class OutboundKeyNotPublishedError extends Error {
  constructor() {
    super("osn-api's outbound ARC key is not published; publish it before signing");
    this.name = "OutboundKeyNotPublishedError";
  }
}

/**
 * A key whose public half is in the published set, as
 * {@link publishOutboundKey} answers it: the only thing
 * {@link arcAuthHeader} signs with.
 */
export interface PublishedOutboundKey {
  readonly keyId: string;
}

/** The private half of each key {@link publishOutboundKey} answered; nothing else can sign. */
const signingKeys = new WeakMap<PublishedOutboundKey, CryptoKey>();

interface OutboundKey {
  readonly privateKey: CryptoKey;
  readonly publicKeyJwk: string;
  readonly keyId: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

interface KeyState {
  readonly key: Promise<OutboundKey>;
  /** Unix seconds. */
  readonly expiresAt: number;
  /**
   * The write of the key's public half: one per key, shared by every caller
   * while it runs and kept once it has; cleared when it fails, so the next
   * caller writes again.
   */
  publishing: Promise<PublishedOutboundKey> | null;
}

let state: KeyState | null = null;

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

function mint(config: OutboundArcConfig): KeyState {
  const expiresAt = nowSeconds() + KEY_TTL_SECONDS;
  const key = (async (): Promise<OutboundKey> => {
    const [pair, keyId] = await Promise.all([
      generateArcKeyPair(),
      mintArcKid(config.kidSecret, expiresAt),
    ]);
    const publicKeyJwk = await exportKeyToJwk(pair.publicKey);
    return { privateKey: pair.privateKey, publicKeyJwk, keyId, expiresAt };
  })();
  const minted: KeyState = { key, expiresAt, publishing: null };
  // A key that failed to mint is dropped, so the next call mints another
  // rather than failing on this one until its rotation.
  key.catch(() => {
    if (state === minted) state = null;
  });
  return minted;
}

/** The isolate's key, replaced when it is within the rotation buffer of its expiry. */
function currentState(config: OutboundArcConfig): KeyState {
  if (!state || nowSeconds() >= state.expiresAt - KEY_ROTATION_BUFFER_SECONDS) {
    state = mint(config);
  }
  return state;
}

/** Writes `current`'s public half, deleting rows that expired more than a day ago. */
async function writePublicHalf(
  db: DbService["db"],
  current: KeyState,
): Promise<PublishedOutboundKey> {
  const key = await current.key;
  const now = nowSeconds();
  await commitBatch(db, [
    db
      .delete(arcOutboundKeys)
      .where(lt(arcOutboundKeys.expiresAt, now - EXPIRED_KEY_GRACE_SECONDS)),
    db
      .insert(arcOutboundKeys)
      .values({
        keyId: key.keyId,
        publicKeyJwk: key.publicKeyJwk,
        createdAt: now,
        expiresAt: key.expiresAt,
      })
      .onConflictDoNothing({ target: arcOutboundKeys.keyId }),
  ]);
  const published: PublishedOutboundKey = { keyId: key.keyId };
  signingKeys.set(published, key.privateKey);
  return published;
}

/**
 * Writes the current key's public half, once per key per isolate, and answers
 * that key: the caller signs with it. Callers that arrive while the write runs
 * wait on the same write, so concurrent first calls cost one batch. On
 * failure the key stays unpublished and the next call writes it again.
 */
export const publishOutboundKey = (
  config: OutboundArcConfig,
): Effect.Effect<PublishedOutboundKey, OutboundKeyPublishError, Db> =>
  Effect.gen(function* () {
    const current = currentState(config);
    const { db } = yield* Db;
    let publishing = current.publishing;
    const writesNow = publishing === null;
    if (publishing === null) {
      const write = writePublicHalf(db, current);
      write.catch(() => {
        if (current.publishing === write) current.publishing = null;
      });
      current.publishing = write;
      publishing = write;
    }
    if (writesNow && config.kidSecret !== undefined && !arcKidMacSecret(config.kidSecret)) {
      yield* Effect.logWarning(
        "osn.arc outbound key id carries no MAC: INTERNAL_SERVICE_SECRET is too short to key one",
      );
    }
    const pending = publishing;
    return yield* Effect.tryPromise({
      try: () => pending,
      catch: (cause) => new OutboundKeyPublishError({ cause }),
    });
  }).pipe(Effect.withSpan("osn.arc.publish_outbound_key"));

/**
 * The `Authorization: ARC <token>` value for `audience` and `scope`, signed
 * with `key`. Throws {@link OutboundKeyNotPublishedError} for a key
 * {@link publishOutboundKey} did not answer: every app would refuse the token.
 */
export async function arcAuthHeader(
  key: PublishedOutboundKey,
  audience: string,
  scope: string,
): Promise<string> {
  const privateKey = signingKeys.get(key);
  if (!privateKey) throw new OutboundKeyNotPublishedError();
  const token = await getOrCreateArcToken(privateKey, {
    iss: OSN_ARC_ISSUER,
    aud: audience,
    scope,
    kid: key.keyId,
  });
  return `ARC ${token}`;
}

/** A downstream answered with a status outside 2xx. */
export class OutboundArcHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`outbound ARC POST ${url} returned ${status}`);
    this.name = "OutboundArcHttpError";
  }
}

/** Where to send one ARC call, as whom, and how long to wait. */
export interface ArcCall {
  readonly audience: string;
  readonly scope: string;
  readonly timeoutMs?: number;
}

async function arcPost(
  key: PublishedOutboundKey,
  url: string,
  body: unknown,
  call: ArcCall,
): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await arcAuthHeader(key, call.audience, call.scope),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(call.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new OutboundArcHttpError(url, res.status);
  return res;
}

/** A JSON value as an app answers it, before the caller decodes it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [member: string]: JsonValue };

/**
 * POSTs JSON to an app with an ARC token signed by the key it has just
 * published, and answers the parsed body, not yet checked: the caller decodes it against
 * the contract. On Workers, Cloudflare traces the call as a `fetch` span in
 * the request's trace.
 */
export const arcPostJsonEffect = (
  url: string,
  body: unknown,
  call: ArcCall,
  config: OutboundArcConfig,
): Effect.Effect<JsonValue, Error | OutboundKeyPublishError, Db> =>
  publishOutboundKey(config).pipe(
    Effect.flatMap((key) =>
      Effect.tryPromise({
        try: async (): Promise<JsonValue> =>
          (await (await arcPost(key, url, body, call)).json()) as JsonValue,
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(`outbound ARC POST ${url} failed`),
      }),
    ),
  );

/**
 * Like {@link arcPostJsonEffect} but answers the raw {@link Response}, so the
 * account export can pipe an app's NDJSON section through without buffering
 * it. Signs with `key`, which the caller has published. Throws on a non-2xx
 * status.
 */
export function arcFetchStream(
  key: PublishedOutboundKey,
  url: string,
  body: unknown,
  call: ArcCall,
): Promise<Response> {
  return arcPost(key, url, body, call);
}

/** Reading the published keys failed. */
export class OutboundKeyReadError extends Data.TaggedError("OutboundKeyReadError")<{
  readonly cause: unknown;
}> {}

/** One published key, as `GET /.well-known/arc-jwks.json` serves it: an EC P-256 public JWK. */
export interface PublishedArcKey {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: "ES256";
  readonly use: "sig";
}

/** The public members of a stored JWK, or null when it holds no EC public key. */
function publicMembers(stored: string): { kty: string; crv: string; x: string; y: string } | null {
  try {
    const { kty, crv, x, y } = JSON.parse(stored) as {
      kty?: string;
      crv?: string;
      x?: string;
      y?: string;
    };
    return typeof kty === "string" &&
      typeof crv === "string" &&
      typeof x === "string" &&
      typeof y === "string"
      ? { kty, crv, x, y }
      : null;
  } catch {
    return null;
  }
}

/**
 * Every key osn-api may still sign with, read fresh: a key an isolate wrote a
 * moment ago must be in the very next answer, or the app asking for it would
 * refuse that kid for 30 seconds. One indexed read over the unexpired rows.
 */
export const publishedOutboundKeys: Effect.Effect<
  ReadonlyArray<PublishedArcKey>,
  OutboundKeyReadError,
  Db
> = Effect.gen(function* () {
  const { db } = yield* Db;
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({ keyId: arcOutboundKeys.keyId, publicKeyJwk: arcOutboundKeys.publicKeyJwk })
        .from(arcOutboundKeys)
        .where(gt(arcOutboundKeys.expiresAt, nowSeconds())),
    catch: (cause) => new OutboundKeyReadError({ cause }),
  });
  // The public members only, whatever a row holds: never a private one.
  return rows.flatMap((row) => {
    const members = publicMembers(row.publicKeyJwk);
    return members
      ? [{ ...members, kid: row.keyId, alg: "ES256" as const, use: "sig" as const }]
      : [];
  });
}).pipe(Effect.withSpan("osn.arc.published_outbound_keys"));

/** Clears the isolate's key, so each test starts with none minted. */
export function _resetOutboundKeyForTests(): void {
  state = null;
}
