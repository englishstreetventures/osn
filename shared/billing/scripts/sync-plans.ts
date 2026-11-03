/**
 * Sync code-defined plans to Stripe. A dry run unless `--apply` is given.
 *
 *   STRIPE_SECRET_KEY=sk_test_… bun run --cwd shared/billing sync-plans -- \
 *     --plans <path to a module that exports `plans`> [--apply] [--live]
 *
 * `--plans` resolves from the directory the command runs in (`shared/billing`
 * under `--cwd`). A live key (`sk_live_…`, or a restricted `rk_live_…`) also
 * needs `--live` to apply. Prints each plan's product and price diffs, and the
 * portal configuration id the consumer stores.
 */

import { isAbsolute, resolve } from "node:path";

import { Effect } from "effect";

import type { AnyPlan } from "../src/plans";
import { createStripeRequest, type FetchFn } from "../src/stripe/http";
import { syncPlans, type SyncReport } from "../src/sync/sync-plans";

export interface ScriptIo {
  readonly write: (line: string) => void;
  readonly cwd: string;
  /** Defaults to `instrumentedFetch`. */
  readonly fetchImpl?: FetchFn;
}

const USAGE =
  "usage: STRIPE_SECRET_KEY=sk_test_… bun run sync-plans -- --plans <module exporting plans> [--apply] [--live]";

/** A secret or restricted key for a live-mode account. */
const LIVE_KEY = /^[sr]k_live_/;

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function describe(report: SyncReport): string[] {
  const lines = [report.applied ? "applied" : "dry run: nothing was written"];
  if (report.conflicts > 0)
    lines.push(`${report.conflicts} conflict(s): nothing will be written until they are resolved`);
  for (const plan of report.plans) {
    lines.push(
      `${plan.planId}: product ${plan.product.action}, price ${plan.price.action}${plan.price.priceId ? ` (${plan.price.priceId})` : ""}`,
    );
    for (const change of [...plan.product.diffs, ...plan.price.diffs]) lines.push(`  ${change}`);
  }
  lines.push(
    `portal configuration: ${report.portal.action}${report.portal.configurationId ? ` ${report.portal.configurationId}` : ""}`,
  );
  for (const change of report.portal.diffs) lines.push(`  ${change}`);
  return lines;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: ScriptIo,
): Promise<number> {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const plansPath = flag(argv, "--plans");
  const apply = argv.includes("--apply");
  if (!secretKey || plansPath === undefined) {
    io.write(USAGE);
    return 2;
  }
  if (apply && LIVE_KEY.test(secretKey) && !argv.includes("--live")) {
    io.write(
      "refusing to apply with a live key without --live: tax_behavior cannot be changed once set",
    );
    return 2;
  }
  const loaded: { readonly plans?: unknown } = await import(
    isAbsolute(plansPath) ? plansPath : resolve(io.cwd, plansPath)
  );
  const plans = loaded.plans;
  if (!Array.isArray(plans)) {
    io.write(`${plansPath} has no \`plans\` export holding a list of plans`);
    return 2;
  }
  const request = createStripeRequest({ secretKey, fetchImpl: io.fetchImpl });
  const outcome = await Effect.runPromise(
    Effect.result(syncPlans({ plans: plans as AnyPlan[], request, apply })),
  );
  if (outcome._tag === "Failure") {
    io.write(
      `Stripe refused: ${outcome.failure.reason}${outcome.failure.code ? ` (${outcome.failure.code})` : ""}`,
    );
    return 1;
  }
  for (const line of describe(outcome.success)) io.write(line);
  return outcome.success.conflicts > 0 ? 1 : 0;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), process.env, {
    write: (line) => void process.stdout.write(`${line}\n`),
    cwd: process.cwd(),
  });
  process.exit(code);
}
