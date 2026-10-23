// The pure half of scripts/deploy-surfaces.ts: which surface a changed path
// redeploys, on which tier, and why. The git half is driven against real
// repositories in deploy-surfaces.cli.test.ts.

import { describe, expect, test } from "bun:test";

import {
  changesContent,
  deployReason,
  devDecisions,
  devStackDecisions,
  isSurfaceKey,
  PRODUCTION_SURFACES,
  sharedPath,
  type StackKey,
  STACKS,
  surface,
  SURFACES,
  WORKFLOW_FILE,
  type SurfaceKey,
} from "../deploy-surfaces";

/** The keys a list of changed files redeploys on `tier`. */
function redeployed(files: readonly string[], tier: "dev" | "production"): SurfaceKey[] {
  const surfaces = tier === "production" ? PRODUCTION_SURFACES : SURFACES;
  return surfaces.filter((s) => deployReason(s, files, tier) !== undefined).map((s) => s.key);
}

/** The dev stacks a push of `files` deploys. */
function stacksDeployed(files: readonly string[]): StackKey[] {
  return devStackDecisions(devDecisions({ event: "push", files }), files, "push")
    .filter((d) => d.deploy)
    .map((d) => d.key);
}

const ALL = SURFACES.map((s) => s.key);
const PRODUCTION = PRODUCTION_SURFACES.map((s) => s.key);
const EVERY_STACK: StackKey[] = ["musubi", "cire", "zap", "pulse"];

describe("the surface map", () => {
  test("names ten surfaces, one key each, each in its product's stack", () => {
    expect(Object.fromEntries(SURFACES.map((s) => [s.key, s.stack]))).toEqual({
      cire_api: "cire",
      cire_invites: "cire",
      cire_host: "cire",
      cire_vendor: "cire",
      cire_landing: "cire",
      osn_api: "musubi",
      osn_social: "musubi",
      musubi_landing: "musubi",
      zap_api: "zap",
      pulse_landing: "pulse",
    });
    expect(new Set(ALL).size).toBe(10);
    expect(STACKS.map((s) => s.key)).toEqual(EVERY_STACK);
  });

  test("every surface has a dev job", () => {
    expect(SURFACES.filter((s) => s.dev === undefined).map((s) => s.key)).toEqual([]);
  });

  test("job ids and names are distinct, over surfaces and stacks", () => {
    const jobs = [
      ...SURFACES.flatMap((s) => (s.production === undefined ? [s.dev] : [s.dev, s.production])),
      ...STACKS.map((s) => s.job),
    ];
    const ids = jobs.map((job) => job.id);
    const names = jobs.map((job) => job.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  test("isSurfaceKey accepts the keys and nothing else", () => {
    for (const key of ALL) expect(isSurfaceKey(key)).toBe(true);
    for (const bad of ["", "cire-api", "cire/api", "CIRE_API", "zap"])
      expect(isSurfaceKey(bad)).toBe(false);
  });

  test("surface() looks a key up", () => {
    expect(surface("osn_social").production?.name).toBe("Deploy musubi/social — production");
  });
});

describe("which surfaces a change redeploys", () => {
  test.each([
    ["cire/api/src/index.ts", ["cire_api"]],
    ["cire/db/migrations/0090_x.sql", ["cire_api"]],
    ["scripts/cire-db-migrate.ts", ["cire_api"]],
    ["scripts/check-d1-database-id.ts", ["cire_api"]],
    ["scripts/migration-files.ts", ["cire_api"]],
    ["cire/db/migrations/20261021031500_add_bio.sql", ["cire_api"]],
    ["cire/invites/src/pages/index.astro", ["cire_invites"]],
    ["cire/host/src/App.tsx", ["cire_host"]],
    ["cire/vendor/src/App.tsx", ["cire_vendor"]],
    ["cire/landing/src/pages/index.astro", ["cire_landing"]],
    ["cire/ui/src/Button.tsx", ["cire_invites", "cire_host", "cire_vendor", "cire_landing"]],
    [
      "cire/dietary/src/index.ts",
      ["cire_api", "cire_invites", "cire_host", "cire_vendor", "cire_landing"],
    ],
    ["cire/theme/src/index.ts", ["cire_api", "cire_invites", "cire_host", "cire_vendor"]],
    ["cire/invite-designs/src/index.ts", ["cire_api", "cire_invites", "cire_host"]],
    ["cire/build-tools/src/index.ts", ["cire_invites", "cire_host", "cire_vendor"]],
    ["osn/api/src/index.ts", ["osn_api"]],
    ["osn/db/drizzle/0009_x.sql", ["osn_api"]],
    ["musubi/social/src/App.tsx", ["osn_social"]],
    ["osn/client/src/index.ts", ["osn_social"]],
    ["osn/auth-ui/src/index.ts", ["osn_social"]],
    ["zap/api/src/index.ts", ["zap_api"]],
    ["zap/db/drizzle/0001_x.sql", ["zap_api"]],
    ["README.md", []],
    ["wiki/shared/production-deploy.md", []],
    ["pulse/app/src/index.ts", []],
    ["scripts/release-plan.ts", []],
  ] as const)("%s", (file, expected) => {
    expect(redeployed([file], "production").toSorted()).toEqual([...expected].toSorted());
  });

  test.each([
    "shared/ui/src/Button.tsx",
    "patches/some-package.patch",
    "bun.lock",
    "package.json",
    "turbo.json",
    "tsconfig.json",
    ".browserslistrc",
    "scripts/deploy-surfaces.ts",
  ])("%s redeploys every surface on both tiers", (file) => {
    expect(redeployed([file], "production")).toEqual(PRODUCTION);
    expect(redeployed([file], "dev")).toEqual(ALL);
  });

  test("a nested package.json is not the root one", () => {
    expect(redeployed(["cire/host/package.json"], "production")).toEqual(["cire_host"]);
  });

  test("each tier's own workflow file redeploys that tier only", () => {
    expect(redeployed([WORKFLOW_FILE.dev], "dev")).toEqual(ALL);
    expect(redeployed([WORKFLOW_FILE.dev], "production")).toEqual([]);
    expect(redeployed([WORKFLOW_FILE.production], "production")).toEqual(PRODUCTION);
    expect(redeployed([WORKFLOW_FILE.production], "dev")).toEqual([]);
  });

  test.each(["scripts/smoke-check.ts", "scripts/worker-deployments.ts"])(
    "%s redeploys every dev surface, each of which runs it, and no production surface",
    (file) => {
      expect(redeployed([file], "dev")).toEqual(ALL);
      expect(stacksDeployed([file])).toEqual(EVERY_STACK);
      expect(redeployed([file], "production")).toEqual([]);
      expect(sharedPath(file, "dev")).toBe(false);
      expect(deployReason(surface("pulse_landing"), [file], "dev")).toBe(
        `${file} changed, which checks every dev deploy`,
      );
    },
  );

  test("scripts/guest-route-parity.ts redeploys the guest site on dev, whose stack job runs it after the deploy, and no production surface", () => {
    const file = "scripts/guest-route-parity.ts";
    expect(redeployed([file], "dev")).toEqual(["cire_invites"]);
    expect(stacksDeployed([file])).toEqual(["cire"]);
    expect(redeployed([file], "production")).toEqual([]);
    expect(sharedPath(file, "dev")).toBe(false);
    expect(deployReason(surface("cire_invites"), [file], "dev")).toBe(
      `${file} changed, which checks this surface's dev deploy`,
    );
  });

  test("a change under cire/infra/ redeploys every cire dev surface and no production surface", () => {
    const file = "cire/infra/alchemy.run.ts";
    expect(redeployed([file], "dev")).toEqual([
      "cire_api",
      "cire_invites",
      "cire_host",
      "cire_vendor",
      "cire_landing",
    ]);
    expect(stacksDeployed([file])).toEqual(["cire"]);
    expect(redeployed([file], "production")).toEqual([]);
    for (const s of SURFACES) expect(changesContent(s, file)).toBe(false);
  });

  test("a change to musubi landing runs the musubi stack", () => {
    const file = "musubi/landing/src/x.astro";
    expect(redeployed([file], "dev")).toEqual(["musubi_landing"]);
    expect(stacksDeployed([file])).toEqual(["musubi"]);
  });

  test("a change under shared/infra/ runs every dev stack and offers production nothing", () => {
    const file = "shared/infra/src/hosts.ts";
    expect(stacksDeployed([file])).toEqual(EVERY_STACK);
    expect(redeployed([file], "dev")).toEqual(ALL);
    expect(redeployed([file], "production")).toEqual([]);
    for (const s of PRODUCTION_SURFACES) expect(changesContent(s, file)).toBe(false);
    // The rest of shared/ is still what every surface builds from.
    expect(redeployed(["shared/ui/src/x.ts"], "dev")).toEqual(ALL);
    expect(redeployed(["shared/ui/src/x.ts"], "production")).toEqual(PRODUCTION);
  });

  test("a change under zap/infra/ runs the zap stack and offers production nothing", () => {
    expect(stacksDeployed(["zap/infra/alchemy.run.ts"])).toEqual(["zap"]);
    expect(changesContent(surface("zap_api"), "zap/infra/alchemy.run.ts")).toBe(false);
    expect(changesContent(surface("zap_api"), "zap/api/src/index.ts")).toBe(true);
  });

  test("the reason names the file that caused it", () => {
    expect(
      deployReason(surface("cire_api"), ["README.md", "cire/api/a.ts", "cire/api/b.ts"], "dev"),
    ).toBe("cire/api/a.ts changed, and 1 more of its files");
    expect(deployReason(surface("cire_api"), ["cire/api/a.ts"], "dev")).toBe(
      "cire/api/a.ts changed",
    );
    expect(deployReason(surface("osn_api"), ["bun.lock", "osn/api/a.ts"], "dev")).toBe(
      "bun.lock changed, which every surface builds from",
    );
    expect(deployReason(surface("osn_api"), ["README.md"], "dev")).toBeUndefined();
  });

  test("sharedPath anchors on the whole path", () => {
    expect(sharedPath("shared/x", "dev")).toBe(true);
    expect(sharedPath("cire/shared/x", "dev")).toBe(false);
    expect(sharedPath("bun.lockb", "dev")).toBe(false);
  });
});

describe("changesContent: what a surface is built from", () => {
  test("its own paths and the shared content", () => {
    expect(changesContent(surface("cire_host"), "cire/host/src/App.tsx")).toBe(true);
    expect(changesContent(surface("cire_host"), "cire/ui/src/Button.tsx")).toBe(true);
    expect(changesContent(surface("cire_host"), "bun.lock")).toBe(true);
    expect(changesContent(surface("cire_host"), "shared/ui/src/Button.tsx")).toBe(true);
  });

  test("not the workflow files or the surface map, which change how it deploys, not what", () => {
    for (const file of [
      WORKFLOW_FILE.dev,
      WORKFLOW_FILE.production,
      "scripts/deploy-surfaces.ts",
      "scripts/smoke-check.ts",
    ]) {
      expect(changesContent(surface("cire_host"), file)).toBe(false);
    }
  });

  test("not another surface's files", () => {
    expect(changesContent(surface("cire_host"), "cire/api/src/index.ts")).toBe(false);
  });
});

describe("devDecisions: the dev tier's push diff", () => {
  const dev = SURFACES.filter((s) => s.dev !== undefined).map((s) => s.key);

  test("decides the dev surfaces only", () => {
    expect(devDecisions({ event: "push", files: [] }).map((d) => d.key)).toEqual(dev);
  });

  test("a push deploys what it changed", () => {
    const decisions = devDecisions({ event: "push", files: ["cire/landing/src/a.astro"] });
    expect(decisions.filter((d) => d.deploy).map((d) => d.key)).toEqual(["cire_landing"]);
  });

  test("a trigger with no diff base deploys everything", () => {
    const decisions = devDecisions({ event: "workflow_dispatch", files: [] });
    expect(decisions.every((d) => d.deploy)).toBe(true);
    expect(decisions[0]?.reason).toContain("workflow_dispatch");
  });

  test("a push that could not be diffed deploys everything", () => {
    const decisions = devDecisions({ event: "push", files: undefined });
    expect(decisions.every((d) => d.deploy)).toBe(true);
    expect(decisions[0]?.reason).toContain("could not be diffed");
  });
});
