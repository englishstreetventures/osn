// The production hosts scripts/smoke-check.ts probes, and the Worker each
// check rolls back, are copies of facts that live elsewhere: each Worker's
// custom-domain route, its Wrangler name, and the marketing origin the guest
// site's build redirects `/` to. A copy that drifts makes the check ask a host
// the Worker does not serve, and roll back a healthy deploy. These hold every
// copy to its source. The stack job passes each check its origin from its
// production-hosts step, which reads PRODUCTION_HOSTS
// (shared/infra/src/production-sites.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { productionHostOutputs } from "../../shared/infra/src/production-sites";
import { SMOKE_CHECKED_ON_DEV, SURFACES, WORKFLOW_FILE } from "../deploy-surfaces";
import { devTarget, productionTarget, SMOKE_TARGETS } from "../smoke-check";

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

/** The custom-domain routes `[env.production]` gives a Worker. */
function envRoutes(cwd: string): string[] {
  const config = Bun.TOML.parse(read(join(cwd, "wrangler.toml"))) as {
    env?: Record<string, { routes?: Route[] }>;
  };
  return (config.env?.production?.routes ?? [])
    .filter((r) => r.custom_domain)
    .map((r) => r.pattern);
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

/**
 * The origin production-hosts writes for a surface, which its smoke step
 * passes as SMOKE_ORIGIN; a test fails on one it lacks.
 */
const productionOrigin = (surface: string): string => {
  const origin = productionHostOutputs().get(`${surface}_origin`);
  if (origin === undefined) throw new Error(`production-hosts writes no ${surface}_origin`);
  return origin;
};

/** The API Workers each Wrangler config named before its stack deployed it. */
const API_CONFIGS = [
  ["cire_api", "cire/api"],
  ["osn_api", "osn/api"],
  ["zap_api", "zap/api"],
] as const;

describe("every API Worker's production check asks the host its wrangler.toml routes, and rolls back the Worker of its name", () => {
  test.each(API_CONFIGS)("%s", (surface, cwd) => {
    const routes = envRoutes(cwd);
    expect(routes.length).toBe(1);
    expect(productionOrigin(surface)).toBe(`https://${routes[0]}`);
    // With no `name` of its own, an environment deploys `<name>-production`.
    const config = Bun.TOML.parse(read(join(cwd, "wrangler.toml"))) as { name: string };
    expect(productionTarget(surface)?.worker).toBe(`${config.name}-production`);
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
    expect(config.routes.map((r) => `https://${r.pattern}`)).toEqual([
      productionOrigin("cire_invites"),
    ]);
    expect(productionTarget("cire_invites")?.worker).toBe(config.name);
  });

  test("production expects `/` to redirect to the build's PUBLIC_MARKETING_URL, the marketing site's own origin", () => {
    const marketing = guestBuildEnv(WORKFLOW_FILE.production, "sites").PUBLIC_MARKETING_URL;
    expect(marketing).toBe(productionOrigin("cire_landing"));
    const redirect = SMOKE_TARGETS.cire_invites.production
      .probes({ origin: productionOrigin("cire_invites"), marketing })
      .find((p) => p.expects.kind === "redirect");
    expect(redirect?.expects).toEqual({ kind: "redirect", to: marketing });
  });

  // The footer prints the commit a guest-site build came from, so a report
  // from a phone names its build. Each job that builds it hands the build the
  // commit the workflow runs on, which is also in turbo's hash as a `PUBLIC_*`
  // variable, so a new commit never replays an old build.
  test.each([
    ["production", WORKFLOW_FILE.production, "sites"],
    ["dev", WORKFLOW_FILE.dev, "stack-cire-dev"],
  ] as const)(
    "%s builds the guest site with the workflow's commit as PUBLIC_BUILD_SHA",
    (_, path, job) => {
      expect(guestBuildEnv(path, job).PUBLIC_BUILD_SHA).toBe("${{ github.sha }}");
    },
  );
});

test("only the dev browser hosts, which sit behind Cloudflare Access, send the Access token", () => {
  // A production target has no `access`: no production host sits behind Access.
  const behindAccess = SURFACES.filter((s) => devTarget(s.key)?.access === true).map(
    (s) => `${s.key} dev`,
  );
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
