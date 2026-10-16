// The pure half of scripts/deploy-surfaces.ts: which surface a changed path
// redeploys, on which tier, and why. The git half is driven against real
// repositories in deploy-surfaces.cli.test.ts.

import { describe, expect, test } from "bun:test";

import {
  changesContent,
  deployReason,
  devDecisions,
  isSurfaceKey,
  sharedPath,
  surface,
  SURFACES,
  WORKFLOW_FILE,
  type SurfaceKey,
} from "../deploy-surfaces";

/** The keys a list of changed files redeploys on `tier`. */
function redeployed(files: readonly string[], tier: "dev" | "production"): SurfaceKey[] {
  return SURFACES.filter((s) => deployReason(s, files, tier) !== undefined).map((s) => s.key);
}

const ALL = SURFACES.map((s) => s.key);

describe("the surface map", () => {
  test("names eight surfaces, one key each", () => {
    expect(ALL.toSorted()).toEqual([
      "cire_api",
      "cire_host",
      "cire_invites",
      "cire_landing",
      "cire_vendor",
      "osn_api",
      "osn_social",
      "zap_api",
    ]);
  });

  test("every surface but zap has a dev job", () => {
    expect(SURFACES.filter((s) => s.dev === undefined).map((s) => s.key)).toEqual(["zap_api"]);
  });

  test("job ids and names are distinct", () => {
    const ids = SURFACES.flatMap((s) => [s.production.id, ...(s.dev ? [s.dev.id] : [])]);
    const names = SURFACES.flatMap((s) => [s.production.name, ...(s.dev ? [s.dev.name] : [])]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  test("isSurfaceKey accepts the keys and nothing else", () => {
    for (const key of ALL) expect(isSurfaceKey(key)).toBe(true);
    for (const bad of ["", "cire-api", "cire/api", "CIRE_API", "zap"])
      expect(isSurfaceKey(bad)).toBe(false);
  });

  test("surface() looks a key up", () => {
    expect(surface("osn_social").production.name).toBe("Deploy musubi/social — production");
  });
});

describe("which surfaces a change redeploys", () => {
  test.each([
    ["cire/api/src/index.ts", ["cire_api"]],
    ["cire/db/migrations/0090_x.sql", ["cire_api"]],
    ["scripts/cire-db-migrate.ts", ["cire_api"]],
    ["scripts/cire-dev-db-guard.ts", ["cire_api"]],
    ["scripts/check-d1-database-id.ts", ["cire_api"]],
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
    expect(redeployed([file], "production")).toEqual(ALL);
    expect(redeployed([file], "dev")).toEqual(ALL);
  });

  test("a nested package.json is not the root one", () => {
    expect(redeployed(["cire/host/package.json"], "production")).toEqual(["cire_host"]);
  });

  test("each tier's own workflow file redeploys that tier only", () => {
    expect(redeployed([WORKFLOW_FILE.dev], "dev")).toEqual(ALL);
    expect(redeployed([WORKFLOW_FILE.dev], "production")).toEqual([]);
    expect(redeployed([WORKFLOW_FILE.production], "production")).toEqual(ALL);
    expect(redeployed([WORKFLOW_FILE.production], "dev")).toEqual([]);
  });

  test("the smoke check redeploys the dev Workers that run it, so a change to it runs there before any release uses it", () => {
    expect(redeployed(["scripts/smoke-check.ts"], "dev")).toEqual([
      "cire_api",
      "cire_invites",
      "osn_api",
    ]);
    expect(redeployed(["scripts/smoke-check.ts"], "production")).toEqual([]);
    expect(sharedPath("scripts/smoke-check.ts", "dev")).toBe(false);
    expect(deployReason(surface("osn_api"), ["scripts/smoke-check.ts"], "dev")).toBe(
      "scripts/smoke-check.ts changed, which checks this Worker's deploy",
    );
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
