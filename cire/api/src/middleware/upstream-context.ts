/**
 * Readers for values that an UPSTREAM plugin parked on the Elysia context.
 *
 * Elysia threads `derive` types down a single fluent chain, and the gates in
 * this directory are built as standalone `new Elysia()` instances that only meet
 * `osnAuth()` (and each other) when `app.ts` composes them with `.use()`. By
 * then their own handler signatures are already fixed, so `osnProfileId` and the
 * role gate's `weddingGateError` are invisible to them however the plugin is
 * written. Route files are different — they `.use(osnAuth(...))` in the same
 * chain, so Elysia types the context for them; destructure there, don't call
 * these.
 *
 * These read the property rather than assert a shape. Anything absent or of the
 * wrong type comes back `undefined`/`false`, which is what the fail-closed
 * branches at every call site already deny on.
 */

/** The OSN profile id `osnAuth()` derived, or undefined if it never ran. */
export function readOsnProfileId(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null || !("osnProfileId" in ctx)) return undefined;
  const value = ctx.osnProfileId;
  return typeof value === "string" ? value : undefined;
}

/**
 * Whether a role gate (weddingMember/weddingEditor/weddingOwner) already parked
 * an error. Only the presence matters — the gate's own onBeforeHandle owns the
 * response.
 */
export function hasWeddingGateError(ctx: unknown): boolean {
  if (typeof ctx !== "object" || ctx === null || !("weddingGateError" in ctx)) return false;
  return Boolean(ctx.weddingGateError);
}
