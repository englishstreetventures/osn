// The hosts scripts/smoke-check.ts probes are copies of facts that live
// elsewhere: each Worker's custom-domain route, and the marketing origin the
// guest site's build redirects `/` to. A copy that drifts makes the check ask
// a host the Worker does not serve, and roll back a healthy deploy. These hold
// every copy to its source.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SMOKE_CHECKED_ON_DEV, WORKFLOW_FILE } from "../deploy-surfaces";
import { SMOKE_TARGETS, type SmokeTarget } from "../smoke-check";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

interface Route {
  readonly pattern: string;
  readonly custom_domain?: boolean;
}

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}

interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const hostsOf = (target: SmokeTarget) => new Set(target.probes.map((p) => new URL(p.url).host));

/** The custom-domain routes `wrangler deploy --env <env>` gives a Worker. */
function envRoutes(cwd: string, env: string): string[] {
  const config = Bun.TOML.parse(read(join(cwd, "wrangler.toml"))) as {
    env?: Record<string, { routes?: Route[] }>;
  };
  return (config.env?.[env]?.routes ?? []).filter((r) => r.custom_domain).map((r) => r.pattern);
}

const workflow = (path: string) => Bun.YAML.parse(read(path)) as Workflow;

/** The env a job passes to the step that builds the guest site. */
function guestBuildEnv(path: string, job: string): Record<string, string> {
  const step = workflow(path).jobs[job]?.steps?.find((s) =>
    s.run?.includes("--filter=@cire/invites"),
  );
  if (step?.env === undefined) throw new Error(`${path} ${job}: no cire/invites build step`);
  return step.env;
}

describe("every --env target probes the hosts its wrangler.toml routes", () => {
  const cases = Object.entries(SMOKE_TARGETS).flatMap(([surface, tiers]) =>
    Object.entries(tiers).flatMap(([tier, target]) =>
      target.wrangler[0] === "--env" ? [[`${surface} ${tier}`, target] as const] : [],
    ),
  );

  test.each(cases)("%s", (_, target) => {
    expect(existsSync(join(root, target.cwd, "wrangler.toml"))).toBe(true);
    const routes = envRoutes(target.cwd, target.wrangler[1] ?? "");
    expect(routes.length).toBeGreaterThan(0);
    expect([...hostsOf(target)]).toEqual(routes);
  });

  // The rollback acts on the Worker by name. With no `name` of its own, an
  // environment deploys `<name>-<env>`.
  test.each(cases)("%s rolls back the Worker `wrangler deploy --env` deploys", (_, target) => {
    const env = target.wrangler[1] ?? "";
    const config = Bun.TOML.parse(read(join(target.cwd, "wrangler.toml"))) as {
      name: string;
      env?: Record<string, { name?: string }>;
    };
    expect(target.worker).toBe(config.env?.[env]?.name ?? `${config.name}-${env}`);
  });
});

test("a change to the check redeploys exactly the dev Workers that run it", () => {
  const devWorkers = Object.entries(SMOKE_TARGETS)
    .filter(([, tiers]) => "dev" in tiers)
    .map(([surface]) => surface);
  expect([...SMOKE_CHECKED_ON_DEV].map(String).toSorted()).toEqual(devWorkers.toSorted());
});

describe("the guest site", () => {
  test("production probes the route cire/invites/wrangler.jsonc gives the Worker, and rolls back that Worker", () => {
    const config = Bun.JSONC.parse(read("cire/invites/wrangler.jsonc")) as {
      name: string;
      routes: Route[];
    };
    const target = SMOKE_TARGETS.cire_invites.production!;
    expect([...hostsOf(target)]).toEqual(config.routes.map((r) => r.pattern));
    expect(config.name).toBe(target.worker);
    // The production job strips one field from the generated config and
    // renames nothing.
    const steps = workflow(WORKFLOW_FILE.production).jobs["deploy-cire-invites"]?.steps ?? [];
    expect(steps.some((s) => s.run?.includes("c.name"))).toBe(false);
  });

  test("dev rolls back the Worker deploy.yml renames the generated config to", () => {
    const steps = workflow(WORKFLOW_FILE.dev).jobs["deploy-cire-invites-dev"]?.steps ?? [];
    const retarget = steps.find((s) => s.name === "Retarget the generated config at dev");
    const name = /c\.name = '([^']+)';/.exec(retarget?.run ?? "");
    expect(name?.[1]).toBe(SMOKE_TARGETS.cire_invites.dev!.worker);
  });

  test("dev probes the route deploy.yml retargets the generated config at", () => {
    const steps = workflow(WORKFLOW_FILE.dev).jobs["deploy-cire-invites-dev"]?.steps ?? [];
    const retarget = steps.find((s) => s.name === "Retarget the generated config at dev");
    const pattern = /c\.routes = \[\{ pattern: '([^']+)', custom_domain: true \}\]/.exec(
      retarget?.run ?? "",
    );
    expect(pattern?.[1]).toBeDefined();
    expect([...hostsOf(SMOKE_TARGETS.cire_invites.dev!)]).toEqual([pattern![1]!]);
  });

  test.each([
    ["production", WORKFLOW_FILE.production, "deploy-cire-invites"],
    ["dev", WORKFLOW_FILE.dev, "deploy-cire-invites-dev"],
  ] as const)(
    "%s expects `/` to redirect to the build's PUBLIC_MARKETING_URL",
    (tier, path, job) => {
      const marketing = guestBuildEnv(path, job).PUBLIC_MARKETING_URL;
      const redirect = SMOKE_TARGETS.cire_invites[tier]!.probes.find(
        (p) => p.expects.kind === "redirect",
      );
      expect(redirect?.expects).toEqual({ kind: "redirect", to: marketing });
    },
  );

  test("only the dev host, which sits behind Cloudflare Access, sends the Access token", () => {
    const behindAccess = Object.entries(SMOKE_TARGETS).flatMap(([surface, tiers]) =>
      Object.entries(tiers).flatMap(([tier, target]) =>
        target.access ? [`${surface} ${tier}`] : [],
      ),
    );
    expect(behindAccess).toEqual(["cire_invites dev"]);
  });
});
