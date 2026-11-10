#!/usr/bin/env bun
/**
 * Which production sites' smoke checks may wait longer, from the plan the
 * release approved:
 *
 *   bun run scripts/smoke-budgets.ts <record.json>
 *
 * The record is the plan guard's (shared/infra/src/plan-guard.ts,
 * `planRecord`): the production stack job downloads it as the `alchemy-plan`
 * artifact, and its guard deploys nothing unless the plan it makes again
 * records the same. Its `domains` lists each site whose Worker's hosts
 * change, with the hosts added and removed.
 *
 * A Workers custom domain gets its own certificate about two minutes after
 * the deploy that attaches it, longer than the smoke check's minute. So for
 * each site the plan attaches a host to that is not a production host, this
 * writes `<site>_budget_ms=<TIMING.maxBudgetMs>` to $GITHUB_OUTPUT (stdout
 * when unset), which that site's smoke step passes as SMOKE_BUDGET_MS. A
 * production host is its zone's apex or one label below it, which the zone's
 * own certificate covers, so attaching one keeps the minute, and a Worker answering
 * wrongly there is rolled back as soon as ever. A site with no new host gets
 * no line, and its step passes "": a minute.
 *
 * Exit codes: 0 written; 1 the file is not such a record, and nothing is
 * written; 2 a usage error.
 *
 * It imports only repository files that import no package, so it runs after
 * the stack job's filtered install, as smoke-check.ts does.
 */
import { appendFileSync, readFileSync } from "node:fs";

import {
  PRODUCTION_HOSTS,
  SITE_SURFACES,
  type SiteSurface,
} from "../shared/infra/src/production-sites";
import { annotation, TIMING } from "./smoke-check";

const PRODUCTION_HOST_SET: ReadonlySet<string> = new Set(Object.values(PRODUCTION_HOSTS));

const isSite = (value: unknown): value is SiteSurface =>
  SITE_SURFACES.some((site) => site === value);

const isHostList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((host) => typeof host === "string");

/**
 * Each site a plan guard record attaches a host to that is not a production
 * host, with those hosts; undefined when `record` is not such a record.
 */
export function newHosts(record: unknown): ReadonlyMap<SiteSurface, readonly string[]> | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const domains: unknown = (record as { readonly domains?: unknown }).domains;
  if (!Array.isArray(domains)) return undefined;
  const found = new Map<SiteSurface, readonly string[]>();
  for (const entry of domains as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { site, added } = entry as { readonly site?: unknown; readonly added?: unknown };
    if (!isSite(site)) return undefined;
    if (!isHostList(added)) return undefined;
    const hosts = added.filter((host) => !PRODUCTION_HOST_SET.has(host));
    if (hosts.length > 0) found.set(site, hosts);
  }
  return found;
}

export interface SmokeBudgetsInput {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
}

export function runSmokeBudgets(input: SmokeBudgetsInput): number {
  const [file = "", ...rest] = input.args;
  if (file === "" || rest.length > 0) {
    input.out(annotation("error", "smoke-budgets: usage: smoke-budgets.ts <plan guard record>"));
    return 2;
  }
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // An unreadable or malformed file is no record, refused below.
  }
  const found = newHosts(record);
  if (found === undefined) {
    input.out(
      annotation(
        "error",
        `smoke-budgets: ${file} is not a plan guard record, a domains list of sites and the hosts each is given, so no smoke check is given longer than ${TIMING.budgetMs / 1000} s.`,
      ),
    );
    return 1;
  }
  const lines = [...found.keys()]
    .map((site) => `${site}_budget_ms=${TIMING.maxBudgetMs}\n`)
    .join("");
  const outputFile = input.env.GITHUB_OUTPUT ?? "";
  if (outputFile === "") {
    input.out(lines);
    return 0;
  }
  appendFileSync(outputFile, lines);
  if (found.size === 0) {
    input.out(
      `No site is given a new host: each smoke check asks for ${TIMING.budgetMs / 1000} s.\n`,
    );
  }
  for (const [site, hosts] of found) {
    input.out(
      `${site}'s smoke check asks for up to ${TIMING.maxBudgetMs / 1000} s: this release gives it ${hosts.join(", ")}.\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(
    runSmokeBudgets({
      args: process.argv.slice(2),
      env: process.env,
      out: (text) => process.stdout.write(text),
    }),
  );
}
