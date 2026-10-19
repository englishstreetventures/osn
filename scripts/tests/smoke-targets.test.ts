// The production hosts scripts/smoke-check.ts probes are copies of facts that
// live elsewhere: each Worker's custom-domain route, and the marketing origin
// the guest site's build redirects `/` to. A copy that drifts makes the check
// ask a host the Worker does not serve, and roll back a healthy deploy. These
// hold every copy to its source. Dev hosts are not copies: the stack job passes
// each check its origin from the same dev-hosts step its deploy reads.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SMOKE_CHECKED_ON_DEV, SURFACES, WORKFLOW_FILE } from "../deploy-surfaces";
import { devTarget, productionTarget, SMOKE_TARGETS, type SmokeTarget } from "../smoke-check";

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

describe("every --env production target probes the hosts its wrangler.toml routes", () => {
  const cases = SURFACES.flatMap((s) => {
    const target = productionTarget(s.key);
    return target?.wrangler[0] === "--env" ? [[`${s.key} production`, target] as const] : [];
  });

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

test("every dev surface has a dev smoke target and every dev smoke target is a dev surface", () => {
  const devTargets = SURFACES.filter((s) => devTarget(s.key) !== undefined).map((s) => s.key);
  expect(Object.keys(SMOKE_TARGETS).toSorted()).toEqual(SURFACES.map((s) => s.key).toSorted());
  expect([...SMOKE_CHECKED_ON_DEV].toSorted()).toEqual(devTargets.toSorted());
  expect(devTargets).toEqual(SURFACES.map((s) => s.key));
});

describe("the guest site", () => {
  test("production probes the route cire/invites/wrangler.jsonc gives the Worker, and rolls back that Worker", () => {
    const config = Bun.JSONC.parse(read("cire/invites/wrangler.jsonc")) as {
      name: string;
      routes: Route[];
    };
    const target = SMOKE_TARGETS.cire_invites.production;
    expect([...hostsOf(target)]).toEqual(config.routes.map((r) => r.pattern));
    expect(config.name).toBe(target.worker);
    // The production job strips one field from the generated config and
    // renames nothing.
    const steps = workflow(WORKFLOW_FILE.production).jobs["deploy-cire-invites"]?.steps ?? [];
    expect(steps.some((s) => s.run?.includes("c.name"))).toBe(false);
  });

  test("production expects `/` to redirect to the build's PUBLIC_MARKETING_URL", () => {
    const marketing = guestBuildEnv(
      WORKFLOW_FILE.production,
      "deploy-cire-invites",
    ).PUBLIC_MARKETING_URL;
    const redirect = SMOKE_TARGETS.cire_invites.production.probes.find(
      (p) => p.expects.kind === "redirect",
    );
    expect(redirect?.expects).toEqual({ kind: "redirect", to: marketing });
  });
});

test("only the dev browser hosts, which sit behind Cloudflare Access, send the Access token", () => {
  const behindAccess = [
    ...SURFACES.filter((s) => devTarget(s.key)?.access === true).map((s) => `${s.key} dev`),
    ...SURFACES.filter((s) => productionTarget(s.key)?.access === true).map(
      (s) => `${s.key} production`,
    ),
  ];
  expect(behindAccess.toSorted()).toEqual(
    [
      "cire_invites dev",
      "cire_host dev",
      "cire_vendor dev",
      "cire_landing dev",
      "osn_social dev",
      "musubi_landing dev",
      "pulse_landing dev",
    ].toSorted(),
  );
});
