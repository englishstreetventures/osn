/**
 * The single environment discriminator for zap-api.
 *
 * Three separate readers used to answer "is this a deployed environment?" and
 * they did not agree: the CORS guard read `ZAP_ENV ?? OSN_ENV`, the ARC bridge
 * read `OSN_ENV` alone, and its https check read `NODE_ENV`. One Worker, three
 * answers — so `[env.production.vars]` naming only one of them left the other
 * two guards silently off. This module is the one predicate they all call.
 *
 * `ZAP_ENV` first, `OSN_ENV` as the fallback: a deployment that runs several
 * OSN services from one env block can name the tier once, and a zap-only
 * deployment can still override it.
 */

/**
 * A whole environment's string vars: `process.env` on Bun, or the Worker's
 * `env` bindings with the non-string ones (the `DB` binding) destructured off.
 * Whole, because every predicate here reads more than one key and a caller that
 * picks out just the key it thinks is relevant loses the tier — which is
 * precisely how a production Worker once resolved a local CORS fallback.
 */
export type DeploymentEnv = Readonly<Record<string, string | undefined>>;

/**
 * True when this is NOT a local developer environment — i.e. the tier is named
 * and is something other than `local`.
 *
 * An env block that names no tier at all reads as local. That is deliberate for
 * the `dev` block (which is also run locally under `wrangler dev --env dev`),
 * and it is why every deployed block must name its tier: an unnamed tier is not
 * a soft default, it is every non-local guard not running.
 */
export function isNonLocalEnv(env: DeploymentEnv): boolean {
  const tier = env.ZAP_ENV ?? env.OSN_ENV;
  return !!tier && tier !== "local";
}
