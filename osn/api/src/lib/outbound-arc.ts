/**
 * Outbound ARC tokens for osn-api: the deletion preview and fan-out, the
 * session end at soft delete, and the account export all call apps with
 * them.
 *
 * Each isolate mints its own ES256 key pair and writes the public half to
 * `arc_outbound_keys`, which `GET /.well-known/arc-jwks.json` serves. Apps
 * verify osn-api's tokens against that set (`@shared/osn-auth-client/arc`), so
 * a key written by any isolate verifies at any app isolate, with no
 * registration call to each app. The kid carries the key's expiry and an HMAC
 * under a key derived from `INTERNAL_SERVICE_SECRET` (`@shared/crypto/arc-kid`),
 * so an app refuses a made-up kid before it fetches the set.
 *
 * The Worker writes the isolate's key after the isolate's first request,
 * whatever the route, and its replacement after the first request once that
 * is due ({@link publishOutboundKeyInBackground}, from `src/index.ts`): which
 * route a request asks for never decides when a key is written. Every
 * outbound call still publishes the key itself before it signs
 * ({@link publishOutboundKey}): no write once the key is written, and a check,
 * at most once every thirty seconds, that the bounded key list still serves it,
 * replacing the key when it does not.
 *
 * {@link publishOutboundKey} answers the key it published, and every
 * signature is made with that key ({@link arcAuthHeader}), never with
 * whichever key the isolate holds by then: a key replaced in between is
 * still in the set. A key lives four hours and is replaced two hours before
 * its expiry; the next publish writes the new one. A caller that signs within
 * two hours of taking its key never signs with an expired one, and a token
 * lives five minutes, so apps need not re-check a key's expiry themselves.
 */
import { arcOutboundKeys } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { exportKeyToJwk, generateArcKeyPair, getOrCreateArcToken } from "@shared/crypto";
import { arcKidMacSecret, mintArcKid } from "@shared/crypto/arc-kid";
import { commitBatch } from "@shared/db-utils";
import { count, desc, gt, gte, lt, sql } from "drizzle-orm";
import { Cause, Data, Effect } from "effect";

/** osn-api's issuer id on every ARC token it signs; apps pin it. */
const OSN_ARC_ISSUER = "osn-api";

/**
 * A key's life, and how long before its end it is replaced. The life bounds
 * the published set to the keys written in the last four hours: one for each
 * isolate that started in that time, two for one older than two hours. The
 * buffer is how long, at least, a caller has to sign with the key it took.
 */
const KEY_TTL_SECONDS = 4 * 3_600;
const KEY_ROTATION_BUFFER_SECONDS = 2 * 3_600;

/** How long after expiry a row stays before a publish deletes it. */
const EXPIRED_KEY_GRACE_SECONDS = 86_400;

/** How long after a background publish fails before a request starts another. */
const BACKGROUND_RETRY_MS = 60_000;

/** The most characters of a failure's reason the background publish logs. */
const FAILURE_REASON_MAX = 200;

/**
 * The most keys `GET /.well-known/arc-jwks.json` serves: the newest, so a key
 * written a moment ago is always among them. A key left out is refused by
 * every app that has not cached it, so the bound sits far above the set's
 * expected size, the read warns from half of it, and a call replaces its key
 * before it signs when the key has fallen out ({@link publishOutboundKey}).
 */
export const PUBLISHED_OUTBOUND_KEYS_BOUND = 1_000;

/** How long a check that the key is still served stands for later calls. */
const SERVED_CHECK_REUSE_MS = 30_000;

/** How often, at most, the read warns about the bound, per isolate. */
const BOUND_WARNING_INTERVAL_MS = 60_000;

/** What signing needs from the deployment. */
export interface OutboundArcConfig {
  /**
   * `INTERNAL_SERVICE_SECRET`, from which the kid MAC key is derived. Unset
   * only on a local run. A value shorter than 32 characters keys no MAC
   * (`@shared/crypto/arc-kid`).
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
   * while it runs and kept once it has. When it fails the key is dropped, and
   * the next caller mints and writes another. Not null means written or being
   * written.
   */
  publishing: Promise<PublishedOutboundKey> | null;
  /** Unix ms of the last check that found the key served; 0 for none. */
  servedAt: number;
  /** The check that runs now, shared by every caller that arrives meanwhile. */
  checking: Promise<boolean> | null;
}

let state: KeyState | null = null;

/** Unix ms before which no background publish starts; 0 when none has failed. */
let backgroundRetryAt = 0;

/** Unix ms of the read's last bound warning; 0 when it has given none. */
let boundWarnedAt = 0;

/**
 * Bumped by {@link _resetOutboundKeyForTests}, so a background publish that
 * settles after a reset leaves the pause it would set alone.
 */
let resetGeneration = 0;

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
  const minted: KeyState = { key, expiresAt, publishing: null, servedAt: 0, checking: null };
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
 * Writes `current`'s public half, once per key per isolate, and answers that
 * key. Callers that arrive while the write runs wait on the same write.
 */
const publishState = (
  config: OutboundArcConfig,
  current: KeyState,
): Effect.Effect<PublishedOutboundKey, OutboundKeyPublishError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    let publishing = current.publishing;
    const writesNow = publishing === null;
    if (publishing === null) {
      const write = writePublicHalf(db, current);
      write.catch(() => {
        if (current.publishing === write) current.publishing = null;
        // A key whose first write failed is dropped, so whichever call writes
        // the isolate's key next writes one whose expiry dates that write.
        if (state === current) state = null;
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
 * Whether `current`'s key is among the keys the bounded read serves: its own
 * row is there (deleting it revokes the key), and fewer than
 * {@link PUBLISHED_OUTBOUND_KEYS_BOUND} live keys expire with it or after it,
 * counting itself, ties included. Reads at most bound + 1 rows down the expiry
 * index. A passing check stands for {@link SERVED_CHECK_REUSE_MS}, and callers
 * that arrive while one runs share it.
 */
const stillServed = (current: KeyState): Effect.Effect<boolean, OutboundKeyPublishError, Db> =>
  Effect.gen(function* () {
    if (Date.now() - current.servedAt < SERVED_CHECK_REUSE_MS) return true;
    const { db } = yield* Db;
    let checking = current.checking;
    if (checking === null) {
      const check = (async (): Promise<boolean> => {
        const own = (await current.key).keyId;
        const ranked = db
          .select({ one: sql`1` })
          .from(arcOutboundKeys)
          .where(gte(arcOutboundKeys.expiresAt, current.expiresAt))
          .limit(PUBLISHED_OUTBOUND_KEYS_BOUND + 1)
          .as("ranked");
        // The count reads the expiry index alone; the key's own row is one
        // primary-key lookup.
        const [row] = await db
          .select({
            keys: count(),
            own: sql<number>`(select count(*) from ${arcOutboundKeys} where ${arcOutboundKeys.keyId} = ${own})`,
          })
          .from(ranked);
        const served =
          (row?.keys ?? 0) <= PUBLISHED_OUTBOUND_KEYS_BOUND && Number(row?.own ?? 0) === 1;
        if (served) current.servedAt = Date.now();
        return served;
      })();
      const settle = (): void => {
        if (current.checking === check) current.checking = null;
      };
      check.then(settle, settle);
      current.checking = check;
      checking = check;
    }
    const pending = checking;
    return yield* Effect.tryPromise({
      try: () => pending,
      catch: (cause) => new OutboundKeyPublishError({ cause }),
    });
  });

/** A replacement key the bounded read would not serve either. */
class OutboundKeyNotServedError extends Error {
  constructor() {
    super("osn-api's outbound ARC key is not among the keys the published set serves");
    this.name = "OutboundKeyNotServedError";
  }
}

/**
 * Writes the current key's public half, once per key per isolate, and answers
 * that key: the caller signs with it. Callers that arrive while the write runs
 * wait on the same write, so concurrent first calls cost one batch. On
 * failure the key is dropped unwritten, and the next call mints and writes
 * another.
 *
 * The key answered is one the bounded read serves: when the current key has
 * fallen outside the newest {@link PUBLISHED_OUTBOUND_KEYS_BOUND}, or its row
 * was deleted, a new key is minted, written and answered instead; callers
 * that find it so together mint one. When even that one would not be served,
 * or the check cannot read the set, the call fails and signs nothing.
 */
export const publishOutboundKey = (
  config: OutboundArcConfig,
): Effect.Effect<PublishedOutboundKey, OutboundKeyPublishError, Db> =>
  Effect.gen(function* () {
    const current = currentState(config);
    const key = yield* publishState(config, current);
    if (yield* stillServed(current)) return key;
    // Minted before anything yields, so one caller mints and the others take its key.
    if (state === current) {
      state = mint(config);
      yield* Effect.logWarning(
        "osn.arc outbound key is not in the published set; minting a new one",
        { bound: PUBLISHED_OUTBOUND_KEYS_BOUND },
      );
    }
    const replacing = currentState(config);
    const replacement = yield* publishState(config, replacing);
    if (yield* stillServed(replacing)) return replacement;
    return yield* Effect.fail(
      new OutboundKeyPublishError({ cause: new OutboundKeyNotServedError() }),
    );
  });

/**
 * The innermost cause's message, cut short: the driver's own words (such as
 * "no such table"), never a query builder's message with the values it bound.
 */
function failureReason(failure: unknown): string {
  let error: unknown = failure;
  for (let depth = 0; depth < 4; depth++) {
    const inner: unknown =
      error !== null && typeof error === "object"
        ? (error as { cause?: unknown }).cause
        : undefined;
    if (inner === undefined || inner === null) break;
    error = inner;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, FAILURE_REASON_MAX);
}

/**
 * What a request does for the isolate's key, after its answer: starts the
 * write of the current key when it has none written or being written, minting
 * one when none is held or the held one is due for replacement, and answers
 * that write for `ctx.waitUntil`. Answers `null` when nothing is due, and for
 * a minute after a background write or mint failed. The write never rejects:
 * a failure is logged, and the next outbound call still mints and writes a key
 * before it signs. `run` runs the effect on the app's runtime.
 */
export function publishOutboundKeyInBackground(
  config: OutboundArcConfig,
  run: (effect: Effect.Effect<void, never, Db>) => Promise<void>,
): Promise<void> | null {
  if (Date.now() < backgroundRetryAt) return null;
  const current = currentState(config);
  if (current.publishing !== null) return null;
  const generation = resetGeneration;
  const pause = (): void => {
    if (generation === resetGeneration) backgroundRetryAt = Date.now() + BACKGROUND_RETRY_MS;
  };
  return run(
    publishState(config, current).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        pause();
        return Effect.logWarning(
          "osn.arc outbound key publish failed; the next call to an app writes a new one",
          { reason: failureReason(Cause.squash(cause)) },
        );
      }),
    ),
  ).catch(pause);
}

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
 * Warns that the live keys pass the bound, or reach half of it, at most once
 * a minute per isolate: anyone may read the set, so no caller sets how often
 * this logs.
 */
const warnAboutBound = (live: number): Effect.Effect<void> => {
  const near = live >= PUBLISHED_OUTBOUND_KEYS_BOUND / 2;
  if (!near || Date.now() - boundWarnedAt < BOUND_WARNING_INTERVAL_MS) return Effect.void;
  boundWarnedAt = Date.now();
  return live > PUBLISHED_OUTBOUND_KEYS_BOUND
    ? Effect.logWarning(
        "osn.arc published outbound keys passed the read bound; the oldest are left out",
        { bound: PUBLISHED_OUTBOUND_KEYS_BOUND },
      )
    : Effect.logWarning("osn.arc published outbound keys are nearing the read bound", {
        bound: PUBLISHED_OUTBOUND_KEYS_BOUND,
        live,
      });
};

/**
 * The keys osn-api may still sign with, newest first, at most
 * {@link PUBLISHED_OUTBOUND_KEYS_BOUND}, read fresh: a key an isolate wrote a
 * moment ago must be in the very next answer, or the app asking for it would
 * refuse that kid for 30 seconds. One read down the expiry index.
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
        .where(gt(arcOutboundKeys.expiresAt, nowSeconds()))
        .orderBy(desc(arcOutboundKeys.expiresAt))
        // One past the bound tells a full set from one that passes it.
        .limit(PUBLISHED_OUTBOUND_KEYS_BOUND + 1),
    catch: (cause) => new OutboundKeyReadError({ cause }),
  });
  yield* warnAboutBound(rows.length);
  // The public members only, whatever a row holds: never a private one.
  return rows.slice(0, PUBLISHED_OUTBOUND_KEYS_BOUND).flatMap((row) => {
    const members = publicMembers(row.publicKeyJwk);
    return members
      ? [{ ...members, kid: row.keyId, alg: "ES256" as const, use: "sig" as const }]
      : [];
  });
}).pipe(Effect.withSpan("osn.arc.published_outbound_keys"));

/** Clears the isolate's key and the pauses, so each test starts as a fresh isolate does. */
export function _resetOutboundKeyForTests(): void {
  state = null;
  backgroundRetryAt = 0;
  boundWarnedAt = 0;
  resetGeneration++;
}
