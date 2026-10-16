#!/usr/bin/env bun
/**
 * The deployable surfaces, and which changed paths redeploy each one.
 *
 * One map for both tiers. `.github/workflows/deploy.yml` runs the CLI below in
 * its `changes` job to decide which dev surfaces, and so which dev stacks, a
 * push redeploys, and `scripts/release-plan.ts` reads the same map to decide
 * which production surfaces a release ships. Two copies of a path list drift:
 * a dependency added to one and not the other leaves a tier that never picks
 * the change up.
 *
 * On dev every surface belongs to one Alchemy stack (STACKS), and a stack job
 * deploys all of its surfaces at once. A stack's own paths (its `infra/`
 * directory, and shared/infra/) change how dev deploys, not what any surface
 * is built from, so they redeploy every dev surface of the stack and offer
 * production nothing. Production ships only the surfaces with a production
 * job (PRODUCTION_SURFACES).
 *
 * Each cire surface lists every `@cire/*` package it bundles, directly or
 * through another one; scripts/tests/deploy-surface-map.test.ts fails when a
 * package.json gains a `@cire/*` dependency this map lacks. cire-api owns the
 * D1 migrations and the seed scripts, so a change to either redeploys it.
 *
 * Anything every surface builds from — the shared/ packages, the dependency
 * patches, the lockfile, the root build config — redeploys everything, rather
 * than mapping each shared package to its consumers (a mapping that rots the
 * first time an import is added). So does the tier's own workflow file, and
 * this file. On dev, a change to scripts/smoke-check.ts or
 * scripts/worker-deployments.ts, which check every dev deploy, redeploys every
 * dev surface, so a change to the check runs there before a release runs it
 * against production.
 *
 * The job ids and names are load-bearing. A GitHub Deployment record does not
 * say which surface it deployed; the name of the job that made it does, and
 * release-plan.ts reads it to find the commit each surface last deployed.
 * scripts/tests/deploy-workflows.test.ts holds both workflows to this map.
 *
 * Usage, as the `changes` job calls it (repository root as the working
 * directory):
 *   deploy-surfaces.ts --event <github.event_name> --base <github.event.before>
 * Writes `<key>=true|false` for each dev surface, then `stack_<key>=true|false`
 * for each stack, to $GITHUB_OUTPUT, or to stdout when that is unset.
 */

import { appendFileSync } from "node:fs";

export type Tier = "dev" | "production";

/** One Alchemy stack per product directory: `musubi/infra`, `cire/infra`, `zap/infra`, `pulse/infra`. */
export type StackKey = "musubi" | "cire" | "zap" | "pulse";

export type SurfaceKey =
  | "cire_api"
  | "cire_invites"
  | "cire_host"
  | "cire_vendor"
  | "cire_landing"
  | "osn_api"
  | "osn_social"
  | "musubi_landing"
  | "zap_api"
  | "pulse_landing";

/** A deploy job: its id in the workflow and the name GitHub shows for it. */
export interface Job {
  readonly id: string;
  readonly name: string;
}

export interface Surface {
  readonly key: SurfaceKey;
  /** Every path whose change redeploys this surface, apart from the shared ones. */
  readonly paths: RegExp;
  /** The stack that deploys this surface on dev. */
  readonly stack: StackKey;
  /** The job in production-release.yml; none for a surface production does not ship yet. */
  readonly production?: Job;
  /** The record job in deploy.yml; it carries the surface's dev Deployment record. */
  readonly dev: Job;
}

/** A surface production ships. */
export type ProductionSurface = Surface & { readonly production: Job };

export interface Stack {
  readonly key: StackKey;
  /** The Alchemy job in deploy.yml. */
  readonly job: Job;
  /** Paths that redeploy every dev surface of the stack and no production surface. */
  readonly paths: RegExp;
}

export const SURFACES: readonly Surface[] = [
  {
    key: "cire_api",
    paths:
      /^(cire\/api\/|cire\/db\/|cire\/dietary\/|cire\/invite-designs\/|cire\/theme\/|scripts\/(cire-db-|check-d1-database-id))/,
    stack: "cire",
    production: { id: "deploy-cire-api", name: "Deploy cire/api — production" },
    dev: { id: "deploy-cire-api-dev", name: "Deploy cire/api — dev" },
  },
  {
    key: "cire_invites",
    paths:
      /^(cire\/invites\/|cire\/build-tools\/|cire\/dietary\/|cire\/invite-designs\/|cire\/theme\/|cire\/ui\/)/,
    stack: "cire",
    production: { id: "deploy-cire-invites", name: "Deploy cire/invites — production" },
    dev: { id: "deploy-cire-invites-dev", name: "Deploy cire/invites — dev" },
  },
  {
    key: "cire_host",
    paths:
      /^(cire\/host\/|cire\/build-tools\/|cire\/dietary\/|cire\/invite-designs\/|cire\/theme\/|cire\/ui\/)/,
    stack: "cire",
    production: { id: "deploy-cire-host", name: "Deploy cire/host — production" },
    dev: { id: "deploy-cire-host-dev", name: "Deploy cire/host — dev" },
  },
  {
    key: "cire_vendor",
    paths: /^(cire\/vendor\/|cire\/build-tools\/|cire\/dietary\/|cire\/theme\/|cire\/ui\/)/,
    stack: "cire",
    production: { id: "deploy-cire-vendor", name: "Deploy cire/vendor — production" },
    dev: { id: "deploy-cire-vendor-dev", name: "Deploy cire/vendor — dev" },
  },
  {
    key: "cire_landing",
    paths: /^(cire\/landing\/|cire\/dietary\/|cire\/ui\/)/,
    stack: "cire",
    production: { id: "deploy-cire-landing", name: "Deploy cire/landing — production (apex)" },
    dev: { id: "deploy-cire-landing-dev", name: "Deploy cire/landing — dev" },
  },
  {
    key: "osn_api",
    paths: /^(osn\/api\/|osn\/db\/)/,
    stack: "musubi",
    production: { id: "deploy-osn-api", name: "Deploy osn/api — production" },
    dev: { id: "deploy-osn-api-dev", name: "Deploy osn/api — dev" },
  },
  {
    key: "osn_social",
    paths: /^(musubi\/social\/|osn\/client\/|shared\/ui\/|osn\/auth-ui\/)/,
    stack: "musubi",
    production: { id: "deploy-osn-social", name: "Deploy musubi/social — production" },
    dev: { id: "deploy-osn-social-dev", name: "Deploy musubi/social — dev" },
  },
  {
    key: "musubi_landing",
    paths: /^musubi\/landing\//,
    stack: "musubi",
    dev: { id: "deploy-musubi-landing-dev", name: "Deploy musubi/landing — dev" },
  },
  {
    key: "zap_api",
    // zap/infra/ is the zap stack's, which changes how dev deploys zap-api,
    // not what it is built from.
    paths: /^zap\/(?!infra\/)/,
    stack: "zap",
    production: { id: "deploy-zap-api", name: "Deploy zap/api — production" },
    dev: { id: "deploy-zap-api-dev", name: "Deploy zap/api — dev" },
  },
  {
    key: "pulse_landing",
    paths: /^pulse\/landing\//,
    stack: "pulse",
    dev: { id: "deploy-pulse-landing-dev", name: "Deploy pulse/landing — dev" },
  },
];

/** The surfaces production ships, in map order. */
export const PRODUCTION_SURFACES: readonly ProductionSurface[] = SURFACES.flatMap((s) => {
  const { production } = s;
  return production === undefined ? [] : [{ ...s, production }];
});

/** Every stack, in deploy order. shared/infra/ is the deploy tooling every stack runs. */
export const STACKS: readonly Stack[] = [
  {
    key: "musubi",
    job: { id: "stack-musubi-dev", name: "Alchemy musubi stack — dev" },
    paths: /^(musubi\/infra\/|shared\/infra\/)/,
  },
  {
    key: "cire",
    job: { id: "stack-cire-dev", name: "Alchemy cire stack — dev" },
    paths: /^(cire\/infra\/|shared\/infra\/)/,
  },
  {
    key: "zap",
    job: { id: "stack-zap-dev", name: "Alchemy zap stack — dev" },
    paths: /^(zap\/infra\/|shared\/infra\/)/,
  },
  {
    key: "pulse",
    job: { id: "stack-pulse-dev", name: "Alchemy pulse stack — dev" },
    paths: /^(pulse\/infra\/|shared\/infra\/)/,
  },
];

/** The workflow that deploys each tier. A change to it redeploys that tier. */
export const WORKFLOW_FILE = {
  dev: ".github/workflows/deploy.yml",
  production: ".github/workflows/production-release.yml",
} as const satisfies Record<Tier, string>;

/** This file. A change to the map redeploys both tiers, as a workflow change does. */
const SURFACE_MAP_FILE = "scripts/deploy-surfaces.ts";

/**
 * The checks every dev deploy runs: the smoke check, and the deployment
 * snapshot it judges a rollback by. A change to either redeploys the dev
 * surfaces that run them, and nothing else: it changes how a deploy is
 * verified, not what is deployed, so production waits for a release that ships
 * for its own reasons.
 */
const DEV_CHECK_FILES: ReadonlySet<string> = new Set([
  "scripts/smoke-check.ts",
  "scripts/worker-deployments.ts",
]);

/**
 * The dev surfaces whose stack job runs the smoke check: every dev surface,
 * the dev targets in scripts/smoke-check.ts's SMOKE_TARGETS.
 * scripts/tests/smoke-targets.test.ts holds the two equal.
 */
export const SMOKE_CHECKED_ON_DEV: ReadonlySet<SurfaceKey> = new Set(SURFACES.map((s) => s.key));

/**
 * What every surface is built from. shared/infra/ is not: no surface imports
 * it, and every stack's paths name it instead.
 */
const SHARED_CONTENT =
  /^(shared\/(?!infra\/)|patches\/|bun\.lock$|package\.json$|turbo\.json$|tsconfig\.json$|\.browserslistrc$)/;

export function isSurfaceKey(value: string): value is SurfaceKey {
  return SURFACES.some((s) => s.key === value);
}

export function surface(key: SurfaceKey): Surface {
  const found = SURFACES.find((s) => s.key === key);
  if (found === undefined) throw new Error(`no surface ${key}`);
  return found;
}

export function stack(key: StackKey): Stack {
  const found = STACKS.find((s) => s.key === key);
  if (found === undefined) throw new Error(`no stack ${key}`);
  return found;
}

/** Whether a change to `file` redeploys every surface on `tier`. */
export function sharedPath(file: string, tier: Tier): boolean {
  return SHARED_CONTENT.test(file) || file === WORKFLOW_FILE[tier] || file === SURFACE_MAP_FILE;
}

/**
 * Whether `file` is part of what `target` is built from: its own paths or the
 * shared content. Workflow files and this map are left out — they change how a
 * surface deploys, not the code that deploys — so two commits that differ only
 * there build the same thing.
 */
export function changesContent(target: Surface, file: string): boolean {
  return SHARED_CONTENT.test(file) || target.paths.test(file);
}

/** Why `files` redeploy `target` on `tier`, or undefined when they do not. */
export function deployReason(
  target: Surface,
  files: readonly string[],
  tier: Tier,
): string | undefined {
  const shared = files.find((file) => sharedPath(file, tier));
  if (shared !== undefined) return `${shared} changed, which every surface builds from`;
  const own = files.filter((file) => target.paths.test(file));
  if (own.length > 0) {
    return own.length === 1
      ? `${own[0]} changed`
      : `${own[0]} changed, and ${own.length - 1} more of its files`;
  }
  if (tier === "production") return undefined;
  const infra = files.find((file) => stack(target.stack).paths.test(file));
  if (infra !== undefined) return `${infra} changed, which the ${target.stack} stack deploys`;
  const check = SMOKE_CHECKED_ON_DEV.has(target.key)
    ? files.find((file) => DEV_CHECK_FILES.has(file))
    : undefined;
  return check === undefined ? undefined : `${check} changed, which checks every dev deploy`;
}

/**
 * The files that differ between two commits' trees, or undefined when git
 * cannot compare them (an unknown commit, the all-zero SHA GitHub sends for a
 * branch's first push, an orphan left by a force-push). A tree diff, not a
 * merge-base one: whatever differs from the base has to deploy, whichever side
 * of history it is on. `--no-renames` lists both paths of a moved file, so a
 * file moved out of a surface's tree still redeploys that surface.
 */
export function changedFiles(
  base: string,
  head: string,
  cwd: string,
): readonly string[] | undefined {
  if (!/^[0-9a-f]{4,40}$/i.test(base) || !/^([0-9a-f]{4,40}|HEAD)$/i.test(head)) return undefined;
  const proc = Bun.spawnSync(["git", "diff", "--name-only", "--no-renames", base, head, "--"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return undefined;
  return proc.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * Whether `ancestor` is an ancestor of `descendant` (a commit counts as its own
 * ancestor). False when git cannot tell, including for a revision that is not
 * a commit SHA.
 */
export function isAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  if (!/^[0-9a-f]{4,40}$/i.test(ancestor) || !/^[0-9a-f]{4,40}$/i.test(descendant)) return false;
  const proc = Bun.spawnSync(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0;
}

export interface Decision {
  readonly key: SurfaceKey;
  readonly deploy: boolean;
  readonly reason: string;
}

/**
 * Which dev surfaces a run of deploy.yml deploys. A trigger with no diff base
 * (`workflow_dispatch` — an operator asking for a deploy wants all of it) and a
 * push that could not be diffed both deploy everything: a wasted deploy costs a
 * minute, a silently skipped one ships a half-updated tier.
 */
export function devDecisions(input: {
  readonly event: string;
  readonly files: readonly string[] | undefined;
}): readonly Decision[] {
  if (input.event !== "push") {
    return SURFACES.map((s) => ({
      key: s.key,
      deploy: true,
      reason: `event '${input.event}' has no diff base`,
    }));
  }
  const files = input.files;
  if (files === undefined) {
    return SURFACES.map((s) => ({
      key: s.key,
      deploy: true,
      reason: "the push could not be diffed",
    }));
  }
  return SURFACES.map((s) => {
    const reason = deployReason(s, files, "dev");
    return {
      key: s.key,
      deploy: reason !== undefined,
      reason: reason ?? "nothing it builds from changed",
    };
  });
}

export interface StackDecision {
  readonly key: StackKey;
  readonly deploy: boolean;
}

/**
 * Which dev stacks a run of deploy.yml deploys: a stack whose surfaces any
 * decision deploys, or whose own paths the push changed. Every stack, as every
 * surface, on a trigger with no diff base or a push that could not be diffed.
 */
export function devStackDecisions(
  decisions: readonly Decision[],
  files: readonly string[] | undefined,
  event: string,
): readonly StackDecision[] {
  return STACKS.map((s) => ({
    key: s.key,
    deploy:
      event !== "push" ||
      files === undefined ||
      decisions.some((d) => d.deploy && surface(d.key).stack === s.key) ||
      files.some((file) => s.paths.test(file)),
  }));
}

/**
 * `<key>=true|false` per dev surface, then `stack_<key>=true|false` per stack,
 * one per line, in the form $GITHUB_OUTPUT takes.
 */
export function outputLines(
  decisions: readonly Decision[],
  stacks: readonly StackDecision[] = [],
): string {
  return [
    ...decisions.map((d) => `${d.key}=${d.deploy}\n`),
    ...stacks.map((s) => `stack_${s.key}=${s.deploy}\n`),
  ].join("");
}

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined) {
    process.stderr.write(`::error::deploy-surfaces: --${name} is required\n`);
    process.exit(2);
  }
  return value;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const event = flag(args, "event");
  const base = event === "push" ? flag(args, "base") : "";
  const files = event === "push" ? changedFiles(base, "HEAD", process.cwd()) : [];
  if (event === "push" && files === undefined) {
    process.stdout.write(`cannot diff against '${base}' — deploying every dev surface\n`);
  } else if (files !== undefined && files.length > 0) {
    process.stdout.write(`changed files:\n${files.map((f) => `  ${f}`).join("\n")}\n`);
  }
  const decisions = devDecisions({ event, files });
  for (const d of decisions) {
    process.stdout.write(`  ${d.key}: ${d.deploy} (${d.reason})\n`);
  }
  const stacks = devStackDecisions(decisions, files, event);
  for (const s of stacks) process.stdout.write(`  stack ${s.key}: ${s.deploy}\n`);
  const lines = outputLines(decisions, stacks);
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined && output !== "") appendFileSync(output, lines);
  else process.stdout.write(lines);
}
