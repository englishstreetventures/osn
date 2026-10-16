#!/usr/bin/env bun
/**
 * The deployable surfaces, and which changed paths redeploy each one.
 *
 * One map for both tiers. `.github/workflows/deploy.yml` runs the CLI below in
 * its `changes` job to decide which dev surfaces a push redeploys, and
 * `scripts/release-plan.ts` reads the same map to decide which production
 * surfaces a release ships. Two copies of a path list drift: a dependency
 * added to one and not the other leaves a tier that never picks the change up.
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
 * this file. On dev, a change to scripts/smoke-check.ts, the check every Worker
 * deploy runs, redeploys the dev Workers that run it, so it runs there before a
 * release runs it against production.
 *
 * The job ids and names are load-bearing. A GitHub Deployment record does not
 * say which surface it deployed; the name of the job that made it does, and
 * release-plan.ts reads it to find the commit each surface last deployed.
 * scripts/tests/deploy-workflows.test.ts holds both workflows to this map.
 *
 * Usage, as the `changes` job calls it (repository root as the working
 * directory):
 *   deploy-surfaces.ts --event <github.event_name> --base <github.event.before>
 * Writes `<key>=true|false` for each dev surface to $GITHUB_OUTPUT, or to stdout
 * when that is unset.
 */

import { appendFileSync } from "node:fs";

export type Tier = "dev" | "production";

export type SurfaceKey =
  | "cire_api"
  | "cire_invites"
  | "cire_host"
  | "cire_vendor"
  | "cire_landing"
  | "osn_api"
  | "osn_social"
  | "zap_api";

/** A deploy job: its id in the workflow and the name GitHub shows for it. */
export interface Job {
  readonly id: string;
  readonly name: string;
}

export interface Surface {
  readonly key: SurfaceKey;
  /** Every path whose change redeploys this surface, apart from the shared ones. */
  readonly paths: RegExp;
  /** The job in .github/workflows/production-release.yml. */
  readonly production: Job;
  /** The job in .github/workflows/deploy.yml. Zap has no dev tier. */
  readonly dev?: Job;
}

export const SURFACES: readonly Surface[] = [
  {
    key: "cire_api",
    paths:
      /^(cire\/api\/|cire\/db\/|cire\/dietary\/|cire\/invite-designs\/|cire\/theme\/|scripts\/(cire-db-|cire-dev-db-guard|check-d1-database-id))/,
    production: { id: "deploy-cire-api", name: "Deploy cire/api — production" },
    dev: { id: "deploy-cire-api-dev", name: "Deploy cire/api — dev" },
  },
  {
    key: "cire_invites",
    paths:
      /^(cire\/invites\/|cire\/build-tools\/|cire\/dietary\/|cire\/invite-designs\/|cire\/theme\/|cire\/ui\/)/,
    production: { id: "deploy-cire-invites", name: "Deploy cire/invites — production" },
    dev: { id: "deploy-cire-invites-dev", name: "Deploy cire/invites — dev" },
  },
  {
    key: "cire_host",
    paths:
      /^(cire\/host\/|cire\/build-tools\/|cire\/dietary\/|cire\/invite-designs\/|cire\/theme\/|cire\/ui\/)/,
    production: { id: "deploy-cire-host", name: "Deploy cire/host — production" },
    dev: { id: "deploy-cire-host-dev", name: "Deploy cire/host — dev" },
  },
  {
    key: "cire_vendor",
    paths: /^(cire\/vendor\/|cire\/build-tools\/|cire\/dietary\/|cire\/theme\/|cire\/ui\/)/,
    production: { id: "deploy-cire-vendor", name: "Deploy cire/vendor — production" },
    dev: { id: "deploy-cire-vendor-dev", name: "Deploy cire/vendor — dev" },
  },
  {
    key: "cire_landing",
    paths: /^(cire\/landing\/|cire\/dietary\/|cire\/ui\/)/,
    production: { id: "deploy-cire-landing", name: "Deploy cire/landing — production (apex)" },
    dev: { id: "deploy-cire-landing-dev", name: "Deploy cire/landing — dev" },
  },
  {
    key: "osn_api",
    paths: /^(osn\/api\/|osn\/db\/)/,
    production: { id: "deploy-osn-api", name: "Deploy osn/api — production" },
    dev: { id: "deploy-osn-api-dev", name: "Deploy osn/api — dev" },
  },
  {
    key: "osn_social",
    paths: /^(musubi\/social\/|osn\/client\/|shared\/ui\/|osn\/auth-ui\/)/,
    production: { id: "deploy-osn-social", name: "Deploy musubi/social — production" },
    dev: { id: "deploy-osn-social-dev", name: "Deploy musubi/social — dev" },
  },
  {
    key: "zap_api",
    paths: /^zap\//,
    production: { id: "deploy-zap-api", name: "Deploy zap/api — production" },
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
 * The check every Worker deploy runs. A change to it redeploys the dev surfaces
 * whose jobs run it, and nothing else: it changes how a deploy is verified, not
 * what is deployed, so production waits for a release that ships for its own
 * reasons, and a Pages surface, which never runs it, has nothing to redeploy.
 */
const SMOKE_CHECK_FILE = "scripts/smoke-check.ts";

/**
 * The dev surfaces whose deploy job runs SMOKE_CHECK_FILE: the dev targets in
 * its SMOKE_TARGETS. scripts/tests/smoke-targets.test.ts holds the two equal.
 */
export const SMOKE_CHECKED_ON_DEV: ReadonlySet<SurfaceKey> = new Set([
  "cire_api",
  "cire_invites",
  "osn_api",
]);

/** What every surface is built from. */
const SHARED_CONTENT =
  /^(shared\/|patches\/|bun\.lock$|package\.json$|turbo\.json$|tsconfig\.json$|\.browserslistrc$)/;

export function isSurfaceKey(value: string): value is SurfaceKey {
  return SURFACES.some((s) => s.key === value);
}

export function surface(key: SurfaceKey): Surface {
  const found = SURFACES.find((s) => s.key === key);
  if (found === undefined) throw new Error(`no surface ${key}`);
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
  if (own.length === 0) {
    return tier === "dev" &&
      SMOKE_CHECKED_ON_DEV.has(target.key) &&
      files.includes(SMOKE_CHECK_FILE)
      ? `${SMOKE_CHECK_FILE} changed, which checks this Worker's deploy`
      : undefined;
  }
  return own.length === 1
    ? `${own[0]} changed`
    : `${own[0]} changed, and ${own.length - 1} more of its files`;
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
  const dev = SURFACES.filter((s) => s.dev !== undefined);
  if (input.event !== "push") {
    return dev.map((s) => ({
      key: s.key,
      deploy: true,
      reason: `event '${input.event}' has no diff base`,
    }));
  }
  const files = input.files;
  if (files === undefined) {
    return dev.map((s) => ({ key: s.key, deploy: true, reason: "the push could not be diffed" }));
  }
  return dev.map((s) => {
    const reason = deployReason(s, files, "dev");
    return {
      key: s.key,
      deploy: reason !== undefined,
      reason: reason ?? "nothing it builds from changed",
    };
  });
}

/** `<key>=true|false`, one per line, in the form $GITHUB_OUTPUT takes. */
export function outputLines(decisions: readonly Decision[]): string {
  return decisions.map((d) => `${d.key}=${d.deploy}\n`).join("");
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
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined && output !== "") appendFileSync(output, outputLines(decisions));
  else process.stdout.write(outputLines(decisions));
}
