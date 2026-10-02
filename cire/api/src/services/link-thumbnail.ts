import { linkThumbTransforms } from "@cire/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { getWaitUntil } from "../lib/execution-ctx";
import { metricRegistryLinkThumb } from "../metrics";
import type { RegistryLinkThumbResult } from "../metrics";
import { detectImageType, MAX_IMAGE_BYTES } from "./invite-assets";
import { buildTransformCacheKey, transformAsset } from "./invite-image-transform";
import type { ImagesBindingLike, OutputFormat } from "./invite-image-transform";
import {
  createDohResolver,
  createUrlGuard,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  guardedFetch,
  readCappedBytes,
} from "./link-preview";
import type { BlockReason, LinkPreviewOptions } from "./link-preview";

/**
 * The link picker's thumbnails — one candidate image from a shop page, fetched
 * by cire-api and re-encoded, so the organiser's browser never loads a shop's
 * host and the portal's CSP `img-src` can stay closed to every https origin.
 *
 * The URL arrives in a request body, so it is fully untrusted, whether or not
 * the preview emitted it a moment ago. It goes through the link-preview guard —
 * `createUrlGuard` + `guardedFetch` + `readCappedBytes`, the same functions the
 * preview and `registry-image.ts` run, not a copy: https only, no credentials,
 * every address behind the host range-checked over DoH, manual redirects
 * re-checked per hop, one 5-second budget across all of it.
 *
 * Then, on the bytes:
 *
 *  - a hard cap of {@link MAX_IMAGE_BYTES}, the same as the image save, so
 *    anything an organiser can pick can be shown. `options.maxBytes` is ignored:
 *    the options object is shared with the preview, whose cap is for HTML.
 *  - `detectImageType` on the leading bytes. The declared type is never the
 *    reason to accept; anything that is not JPEG, PNG or WebP is refused.
 *  - the Images binding at the `thumb` width (320px) in the negotiated format.
 *    A failed transform is an error, never a fallback to the shop's bytes.
 *
 * Without the binding the sniffed bytes are served as they arrived — the local
 * path, where `bun run dev` has no Images binding. A deployed tier sets
 * `requireTransform`, and there a missing binding refuses before any fetch, so
 * a deploy that loses `[images]` cannot turn this into a raw image proxy.
 *
 * Every binding call is treated as billed, and the account's Images quota is
 * shared with the invite images guests load, so a transformed thumbnail is
 * stored in the Workers Cache API for 30 days under a synthetic key — the
 * SHA-256 of the URL and the output format — and a repeat is served from there
 * with no fetch and no transform. The key holds no wedding: the bytes are a
 * shop's public product image, the same for every couple who pastes that page,
 * so one transform serves them all. It is looked up only after the route's
 * gates, and the URL never appears in it in plain text.
 *
 * A cache miss also spends from a monthly budget, {@link MONTHLY_THUMB_TRANSFORMS}
 * across every wedding, counted in D1 (`link_thumb_transforms`) because the
 * route's rate limiter counts per minute and per colo and cannot bound a month.
 * The budget is read before the fetch, so a spent month costs no outbound
 * work, and charged with one conditional upsert just before the transform, so
 * two isolates cannot both spend the last one.
 *
 * Logs carry bounded reasons only, never the URL: a registry link names
 * something the couple is buying.
 */

export class LinkThumbBlocked extends Data.TaggedError("LinkThumbBlocked")<{
  readonly reason: BlockReason;
}> {}

export class LinkThumbFetchFailed extends Data.TaggedError("LinkThumbFetchFailed")<{
  readonly reason: "network" | "timeout" | "status" | "too_many_redirects";
}> {}

/** The bytes are not JPEG, PNG or WebP (magic-byte verdict). */
export class LinkThumbUnsupportedType extends Data.TaggedError("LinkThumbUnsupportedType")<{
  /** The DECLARED type, for the log line only. */
  readonly declared?: string;
}> {}

export class LinkThumbTooLarge extends Data.TaggedError("LinkThumbTooLarge")<{
  readonly limit: number;
}> {}

/** The Images binding refused or failed — a spent quota included. */
export class LinkThumbTransformFailed extends Data.TaggedError("LinkThumbTransformFailed") {}

/** A deployed tier with no Images binding: we will not serve unencoded bytes. */
export class LinkThumbUnavailable extends Data.TaggedError("LinkThumbUnavailable") {}

/** This month's share of the Images quota is spent. */
export class LinkThumbBudgetSpent extends Data.TaggedError("LinkThumbBudgetSpent") {}

/** Recent transforms failed, so this one is not attempted (see {@link createTransformBreaker}). */
export class LinkThumbTransformPaused extends Data.TaggedError("LinkThumbTransformPaused") {}

/**
 * Transforms the picker may spend in one calendar month (UTC), across every
 * wedding: half of the 5,000 unique transformations the Images Free plan gives
 * the account, so the invite images guests load keep the other half.
 */
export const MONTHLY_THUMB_TRANSFORMS = 2_500;

export type LinkThumbError =
  | LinkThumbBlocked
  | LinkThumbFetchFailed
  | LinkThumbUnsupportedType
  | LinkThumbTooLarge
  | LinkThumbTransformFailed
  | LinkThumbUnavailable
  | LinkThumbBudgetSpent
  | LinkThumbTransformPaused;

/**
 * What the breaker says about one request: transform as normal, go as the one
 * trial after a pause, or skip the fetch and the transform.
 */
export type TransformAdmission = "go" | "trial" | "paused";

export interface TransformBreaker {
  admit(): TransformAdmission;
  /** The transform failed for a reason that is not the input's fault. */
  failed(): void;
  succeeded(): void;
  /** A trial ended before reaching the transform, so it says nothing about Images. */
  release(): void;
}

export interface TransformBreakerOptions {
  /** Failures inside {@link TransformBreakerOptions.windowMs} that start a pause. */
  readonly threshold?: number;
  readonly windowMs?: number;
  readonly pauseMs?: number;
  readonly now?: () => number;
}

/**
 * Stops spending fetches on thumbnails the Images binding cannot produce — a
 * spent account quota or an outage. Three failed transforms inside 60 seconds
 * pause transforms for 60 seconds: a request answers 502 before the budget read
 * and the fetch. When the pause ends, ONE request goes through as a trial while
 * the rest stay paused; its failure starts another pause, its success clears
 * the count. A trial that has not settled after a pause's length is treated as
 * lost, so a dropped request cannot hold the route shut.
 *
 * One breaker covers one caller (see {@link createTransformBreakers}), so a
 * caller whose inputs keep failing pauses only their own thumbnails.
 */
export function createTransformBreaker(options: TransformBreakerOptions = {}): TransformBreaker {
  const { threshold = 3, windowMs = 60_000, pauseMs = 60_000, now = Date.now } = options;
  let streak = 0;
  let streakStart = 0;
  let pausedUntil = 0;
  let tripped = false;
  let trialSince: number | null = null;

  return {
    admit() {
      if (!tripped) return "go";
      const t = now();
      if (t < pausedUntil) return "paused";
      if (trialSince !== null && t - trialSince < pauseMs) return "paused";
      trialSince = t;
      return "trial";
    },
    failed() {
      const t = now();
      trialSince = null;
      if (tripped) {
        pausedUntil = t + pauseMs;
        return;
      }
      if (streak === 0 || t - streakStart > windowMs) {
        streak = 1;
        streakStart = t;
      } else {
        streak += 1;
      }
      if (streak >= threshold) {
        tripped = true;
        pausedUntil = t + pauseMs;
      }
    },
    succeeded() {
      streak = 0;
      tripped = false;
      pausedUntil = 0;
      trialSince = null;
    },
    release() {
      trialSince = null;
    },
  };
}

/**
 * One {@link createTransformBreaker} per caller, so failures one organiser's
 * inputs cause never pause another organiser's thumbnails. The route keys it on
 * `osnProfileId`. The state lives in one isolate (the route factory builds one
 * set per app, and the app is built once per isolate), so each isolate learns
 * of an outage on its own, and the first pause can take as many failures as
 * were in flight. At most `maxCallers` are kept; the least recently used goes
 * first, which forgets that caller's count.
 */
export interface TransformBreakers {
  forCaller(key: string): TransformBreaker;
}

export function createTransformBreakers(
  options: TransformBreakerOptions & { readonly maxCallers?: number } = {},
): TransformBreakers {
  const { maxCallers = 1_000, ...breakerOptions } = options;
  const breakers = new Map<string, TransformBreaker>();
  return {
    forCaller(key) {
      const existing = breakers.get(key);
      if (existing) {
        breakers.delete(key);
        breakers.set(key, existing);
        return existing;
      }
      if (breakers.size >= maxCallers) {
        const oldest = breakers.keys().next();
        if (!oldest.done) breakers.delete(oldest.value);
      }
      const created = createTransformBreaker(breakerOptions);
      breakers.set(key, created);
      return created;
    },
  };
}

/**
 * Did the binding refuse the input rather than fail on its own? Such a failure
 * says nothing about the quota, so it does not count toward a pause. 9412 is
 * the Images binding's "input is not an image" code (`ImagesBinding.info` in
 * `@cloudflare/workers-types`).
 */
function isInputRejection(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === 9412;
}

/**
 * Headers on every thumbnail. The bytes came from a host the caller chose, so
 * the response says what it is and nothing else may be made of it: `nosniff`
 * pins the type, and the sandboxing CSP stops it running as a document if it is
 * ever opened as one. `private, no-store`: these are one organiser's picks.
 */
function thumbHeaders(contentType: string) {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
    Vary: "Accept, Origin",
  };
}

/** What the stored copy says, so the Cache API accepts it. Never sent to a client. */
const STORED_CACHE_CONTROL = "public, max-age=2592000";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function resultOf(error: LinkThumbError): RegistryLinkThumbResult {
  switch (error._tag) {
    case "LinkThumbBlocked":
      return "blocked";
    case "LinkThumbFetchFailed":
      return "fetch_failed";
    case "LinkThumbUnsupportedType":
      return "unsupported_type";
    case "LinkThumbTooLarge":
      return "too_large";
    case "LinkThumbTransformFailed":
      return "transform_failed";
    case "LinkThumbUnavailable":
      return "unavailable";
    case "LinkThumbBudgetSpent":
      return "budget_spent";
    case "LinkThumbTransformPaused":
      return "transform_paused";
  }
}

/** One log line per failure, bounded annotations only, never the URL. */
function logFailure(error: LinkThumbError): Effect.Effect<void> {
  switch (error._tag) {
    case "LinkThumbBlocked":
      return error.reason === "private_address"
        ? Effect.logError("link thumbnail refused a non-public destination").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          )
        : Effect.logWarning("link thumbnail refused a url").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          );
    case "LinkThumbFetchFailed":
      return Effect.logWarning("link thumbnail fetch failed").pipe(
        Effect.annotateLogs({ reason: error.reason }),
      );
    case "LinkThumbUnsupportedType":
      return Effect.logWarning("link thumbnail rejected — bytes are not an allowed image").pipe(
        Effect.annotateLogs({ declared: (error.declared ?? "none").slice(0, 64) }),
      );
    case "LinkThumbTooLarge":
      return Effect.logWarning("link thumbnail rejected — over the byte cap").pipe(
        Effect.annotateLogs({ limit: error.limit }),
      );
    case "LinkThumbTransformFailed":
      return Effect.logWarning("link thumbnail transform failed");
    case "LinkThumbUnavailable":
      return Effect.logError("link thumbnail refused: no Images binding in a deployed tier");
    case "LinkThumbBudgetSpent":
      return Effect.logWarning("link thumbnail refused: this month's transform budget is spent");
    case "LinkThumbTransformPaused":
      return Effect.logWarning("link thumbnail skipped: recent transforms failed");
  }
}

/** The budget's row key: the calendar month, UTC. */
function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Is any of this month's budget left? A read, so a spent month costs no fetch. */
function budgetLeft(cap: number): Effect.Effect<boolean, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const row = yield* dbQuery(() =>
      db
        .select({ used: linkThumbTransforms.used })
        .from(linkThumbTransforms)
        .where(eq(linkThumbTransforms.period, currentPeriod()))
        .get(),
    );
    return (row?.used ?? 0) < cap;
  });
}

/**
 * Spend one transform from this month's budget, answering the month it was
 * charged to, or null when the budget is spent. One statement: the upsert only
 * increments while `used` is under the cap, and returns no row when it is not,
 * so concurrent isolates cannot overspend.
 */
function chargeTransform(cap: number): Effect.Effect<string | null, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const period = currentPeriod();
    const rows = yield* dbQuery(() =>
      db
        .insert(linkThumbTransforms)
        .values({ period, used: 1 })
        .onConflictDoUpdate({
          target: linkThumbTransforms.period,
          set: { used: sql`${linkThumbTransforms.used} + 1` },
          setWhere: sql`${linkThumbTransforms.used} < ${cap}`,
        })
        .returning({ used: linkThumbTransforms.used })
        .all(),
    );
    return rows.length > 0 ? period : null;
  });
}

/**
 * Give back a transform the binding failed to make for a reason of its own (an
 * outage or a spent account quota), so a failure does not use up the month.
 * Charged to the same month the charge went to, even across a month's turn.
 */
function refundTransform(period: string): Effect.Effect<void, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    yield* dbQuery(() =>
      db
        .update(linkThumbTransforms)
        .set({ used: sql`${linkThumbTransforms.used} - 1` })
        .where(and(eq(linkThumbTransforms.period, period), gt(linkThumbTransforms.used, 0)))
        .run(),
    );
  });
}

export interface LinkThumbnailArgs {
  /** The inbound request — read for `waitUntil` only. */
  readonly request: Request;
  readonly rawUrl: string;
  readonly format: OutputFormat;
  readonly images?: ImagesBindingLike;
  /** Refuse rather than serve unencoded bytes when `images` is absent. */
  readonly requireTransform: boolean;
  /** Test seam: fetch + DNS. `maxBytes` is ignored — see the module comment. */
  readonly options?: LinkPreviewOptions;
  /** Test seam: the monthly budget. Defaults to {@link MONTHLY_THUMB_TRANSFORMS}. */
  readonly monthlyTransforms?: number;
  /** Pauses transforms after repeated failures. Absent ⇒ every request is attempted. */
  readonly breaker?: TransformBreaker;
}

/** Fetch, check, re-encode and answer one thumbnail. */
function thumbnail(args: LinkThumbnailArgs): Effect.Effect<Response, LinkThumbError, DbService> {
  const {
    request,
    rawUrl,
    format,
    images,
    requireTransform,
    options = {},
    monthlyTransforms = MONTHLY_THUMB_TRANSFORMS,
    breaker,
  } = args;
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    resolveHost = createDohResolver(fetchImpl),
  } = options;
  // Set while this request holds the breaker's trial and has not reached the
  // transform; a request that stops earlier frees the trial for the next one.
  let unsettledTrial = false;

  return Effect.gen(function* () {
    if (!images && requireTransform) return yield* Effect.fail(new LinkThumbUnavailable());

    // Only transformed bytes are ever stored, so the store is consulted only
    // when the binding is there to produce them.
    const cache =
      images && typeof caches !== "undefined" && caches.default ? caches.default : undefined;
    const cacheKey = cache
      ? buildTransformCacheKey({
          slug: "link-thumb",
          slot: yield* Effect.promise(() => sha256Hex(rawUrl)),
          variant: "thumb",
          format,
        })
      : undefined;
    if (cache && cacheKey) {
      const hit = yield* Effect.promise(() => cache.match(cacheKey));
      if (hit) {
        metricRegistryLinkThumb("cache_hit");
        const headers = thumbHeaders(hit.headers.get("Content-Type") ?? format);
        return new Response(hit.body, { status: 200, headers });
      }
    }

    // After a cache miss, so a stored thumbnail is still served while paused.
    const admission = images && breaker ? breaker.admit() : "go";
    if (admission === "paused") return yield* Effect.fail(new LinkThumbTransformPaused());
    unsettledTrial = admission === "trial";

    if (images && !(yield* budgetLeft(monthlyTransforms))) {
      return yield* Effect.fail(new LinkThumbBudgetSpent());
    }

    // One budget for every hop, the DNS lookups and the body read.
    const signal = AbortSignal.timeout(timeoutMs);
    const guard = createUrlGuard(resolveHost, signal);
    const fetched = yield* Effect.promise(() =>
      guardedFetch({
        url: rawUrl,
        guard,
        fetchImpl,
        maxRedirects,
        signal,
        accept: "image/*",
        userAgent: "cire-link-thumb/1.0",
      }),
    );
    if (!fetched.ok) {
      const failure = fetched.failure;
      return yield* Effect.fail(
        failure.kind === "blocked"
          ? new LinkThumbBlocked({ reason: failure.reason })
          : new LinkThumbFetchFailed({ reason: failure.reason }),
      );
    }

    const declared = fetched.response.headers.get("content-type") ?? undefined;
    const read = yield* Effect.promise(() =>
      readCappedBytes(fetched.response, MAX_IMAGE_BYTES).then(
        (r) => ({ ok: true as const, r }),
        // A read that rejects mid-stream is the remote hanging up or the
        // budget running out, not a size verdict.
        () => ({ ok: false as const, r: undefined }),
      ),
    );
    if (!read.ok) {
      return yield* Effect.fail(
        new LinkThumbFetchFailed({ reason: signal.aborted ? "timeout" : "network" }),
      );
    }
    if (!read.r.ok) return yield* Effect.fail(new LinkThumbTooLarge({ limit: MAX_IMAGE_BYTES }));

    const bytes = read.r.bytes.buffer as ArrayBuffer;
    const contentType = detectImageType(bytes);
    if (contentType === null) {
      return yield* Effect.fail(new LinkThumbUnsupportedType({ declared }));
    }

    if (!images) {
      metricRegistryLinkThumb("original");
      return new Response(bytes, { status: 200, headers: thumbHeaders(contentType) });
    }

    const charged = yield* chargeTransform(monthlyTransforms);
    if (charged === null) return yield* Effect.fail(new LinkThumbBudgetSpent());
    const trial = unsettledTrial;
    unsettledTrial = false;
    const out = yield* transformAsset(images, { bytes, contentType }, "thumb", format).pipe(
      Effect.tapError((error) => {
        // An input the binding refused says nothing about Images, so a trial
        // that hit one goes back for the next request to try.
        if (isInputRejection(error.cause)) {
          return Effect.sync(() => {
            if (trial) breaker?.release();
          });
        }
        return Effect.sync(() => breaker?.failed()).pipe(Effect.andThen(refundTransform(charged)));
      }),
      Effect.mapError(() => new LinkThumbTransformFailed()),
    );
    breaker?.succeeded();
    metricRegistryLinkThumb("ok");
    const response = new Response(out.bytes, {
      status: 200,
      headers: thumbHeaders(out.contentType),
    });

    if (cache && cacheKey) {
      const stored = new Response(out.bytes.slice(0), {
        headers: { "Content-Type": out.contentType, "Cache-Control": STORED_CACHE_CONTROL },
      });
      const put = Effect.tryPromise({
        try: () => cache.put(cacheKey, stored),
        catch: (cause) => cause,
      }).pipe(
        // A refused put is a missed cache, not a failed request.
        Effect.catch(() => Effect.logWarning("link thumbnail cache put failed")),
      );
      const waitUntil = getWaitUntil(request);
      if (waitUntil) waitUntil(Effect.runPromise(put));
      else yield* put;
    }
    return response;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (unsettledTrial) breaker?.release();
      }),
    ),
    Effect.tapError((error) =>
      logFailure(error).pipe(
        Effect.andThen(Effect.sync(() => metricRegistryLinkThumb(resultOf(error)))),
      ),
    ),
    Effect.withSpan("cire.registry.link_thumb"),
  );
}

export const linkThumbnailService = { thumbnail };
