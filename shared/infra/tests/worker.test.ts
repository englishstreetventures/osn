import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { tierSecrets } from "../src/secrets/inventory";
import { requireSecrets } from "../src/secrets/require";
import type { Tier } from "../src/stage";
import {
  apiWorkerProps,
  BindingNameClashError,
  ProductionObservabilityError,
  ProductionPreviewUrlsError,
  SecretAsPlainBindingError,
  siteWorkerProps,
  UndeclaredSecretsError,
  type ApiWorkerInput,
} from "../src/worker";

/** Every secret the inventory requires of cire-api on `tier`, each with a placeholder value. */
const cireApiSecrets = (tier: Tier): Record<string, Redacted.Redacted<string>> =>
  Object.fromEntries(
    tierSecrets("cire-api", tier).secrets.map((name) => [name, Redacted.make("not-a-real-secret")]),
  );

/** The installed Alchemy package's directory, as this package resolves it. */
function alchemyDir(): string {
  let dir = dirname(createRequire(import.meta.url).resolve("alchemy"));
  while (!existsSync(join(dir, "src", "Cloudflare", "Workers", "Sources", "Rolldown.ts"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no Alchemy source above the resolved entry");
    dir = parent;
  }
  return dir;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

const cireApiDev: ApiWorkerInput = {
  worker: "cire-api",
  name: "cire-api-dev",
  stage: "dev",
  main: "../../cire/api/src/index.ts",
  bundle: true,
  assets: null,
  compatibility: {
    date: "2025-03-01",
    flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
  },
  domain: "api.dev.cireweddings.com",
  crons: ["0 4 * * *"],
  workersDev: false,
  previewUrls: false,
  vars: { OSN_ENV: "dev" },
  bindings: {},
  secrets: cireApiSecrets("dev"),
  observability: {
    headSamplingRate: 1,
    redactQueryString: false,
    traces: { enabled: true, headSamplingRate: 1 },
    issues: false,
  },
};

const cireApiProduction: ApiWorkerInput = {
  ...cireApiDev,
  name: "cire-api-production",
  stage: "production",
  domain: "api.cireweddings.com",
  secrets: cireApiSecrets("production"),
  observability: {
    headSamplingRate: 1,
    redactQueryString: true,
    traces: { enabled: false },
    issues: true,
  },
};

describe("apiWorkerProps", () => {
  test("serves workers.dev and version preview URLs only as the input says", () => {
    expect(apiWorkerProps(cireApiDev).workersDev).toEqual({
      enabled: false,
      previewsEnabled: false,
    });
    expect(apiWorkerProps({ ...cireApiDev, stage: "pr-7", previewUrls: true }).workersDev).toEqual({
      enabled: false,
      previewsEnabled: true,
    });
    expect(apiWorkerProps({ ...cireApiDev, workersDev: true }).workersDev).toEqual({
      enabled: true,
      previewsEnabled: false,
    });
  });

  test("refuses version preview URLs on production", () => {
    expect(apiWorkerProps(cireApiProduction).workersDev).toEqual({
      enabled: false,
      previewsEnabled: false,
    });
    expect(() => apiWorkerProps({ ...cireApiProduction, previewUrls: true })).toThrow(
      ProductionPreviewUrlsError,
    );
  });

  test.each([
    ["an optional secret", "osn-api", "production", { OSN_TOTP_ENCRYPTION_KEY_PREVIOUS: "plain" }],
    ["a forbidden name", "cire-api", "production", { RESEND_API_URL: "http://localhost:3010" }],
    ["the other tier's secret", "cire-api", "production", { STRIPE_SECRET_KEY: "plain" }],
  ] as const)(
    "refuses %s as a plain var, naming it and never its value",
    (_kind, worker, stage, vars) => {
      const secrets = Object.fromEntries(
        tierSecrets(worker, stage).secrets.map((name) => [
          name,
          Redacted.make("not-a-real-secret"),
        ]),
      );
      const error = thrown(() =>
        apiWorkerProps({
          ...cireApiProduction,
          worker,
          name: `${worker}-${stage}`,
          stage,
          secrets,
          vars,
        }),
      );
      expect(error).toBeInstanceOf(SecretAsPlainBindingError);
      expect(error).toMatchObject({ names: Object.keys(vars) });
      expect((error as Error).message).not.toContain(Object.values(vars)[0]);
    },
  );

  test("refuses a binding named like a secret the inventory lists", () => {
    expect(() =>
      apiWorkerProps({ ...cireApiDev, bindings: { RESEND_API_URL: {} as never } }),
    ).toThrow(SecretAsPlainBindingError);
  });

  test("keeps query strings redacted and native traces off on production", () => {
    expect(apiWorkerProps(cireApiProduction).observability).toEqual({
      enabled: true,
      headSamplingRate: 1,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: false },
      issues: { enabled: true },
    });
    expect(() =>
      apiWorkerProps({
        ...cireApiProduction,
        observability: { ...cireApiProduction.observability, redactQueryString: false },
      }),
    ).toThrow(ProductionObservabilityError);
    expect(() =>
      apiWorkerProps({
        ...cireApiProduction,
        observability: { ...cireApiProduction.observability, traces: { enabled: true } },
      }),
    ).toThrow(/traces/);
  });

  test("keeps invocation logs off unless the caller turns them on", () => {
    expect(apiWorkerProps(cireApiDev).observability).toEqual({
      enabled: true,
      headSamplingRate: 1,
      redactQueryString: false,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: true, headSamplingRate: 1 },
      issues: { enabled: false },
    });
    const on = apiWorkerProps({
      ...cireApiDev,
      observability: { ...cireApiDev.observability, invocationLogs: true },
    });
    expect(on.observability?.logs).toEqual({ enabled: true, invocationLogs: true });
  });

  test("passes every var, binding and secret through env, secrets still redacted", () => {
    const withBinding: ApiWorkerInput = { ...cireApiDev, bindings: { CIRE_DB: {} as never } };
    const env = apiWorkerProps(withBinding).env as Record<string, unknown>;
    expect(Object.keys(env).toSorted()).toEqual(
      ["CIRE_DB", "OSN_ENV", ...tierSecrets("cire-api", "dev").secrets].toSorted(),
    );
    expect(Redacted.isRedacted(env.CIRE_OIDC_CLIENT_SECRET)).toBe(true);
  });

  test("refuses one name in two binding groups", () => {
    expect(() =>
      apiWorkerProps({ ...cireApiDev, vars: { CIRE_OIDC_CLIENT_SECRET: "plain" } }),
    ).toThrow(BindingNameClashError);
    expect(() => apiWorkerProps({ ...cireApiDev, bindings: { OSN_ENV: {} as never } })).toThrow(
      BindingNameClashError,
    );
    expect(() =>
      apiWorkerProps({ ...cireApiDev, bindings: { CIRE_OIDC_CLIENT_SECRET: {} as never } }),
    ).toThrow(BindingNameClashError);
  });

  test("refuses a name Alchemy binds itself", () => {
    expect(() => apiWorkerProps({ ...cireApiDev, vars: { ALCHEMY_STAGE: "dev" } })).toThrow(
      /ALCHEMY_STAGE/,
    );
    expect(() => apiWorkerProps({ ...cireApiDev, bindings: { ALCHEMY_X: {} as never } })).toThrow(
      /ALCHEMY_X/,
    );
  });

  test("passes an optional secret held during a rotation, still redacted", () => {
    const row = tierSecrets("osn-api", "production");
    const [optional] = row.optional;
    if (optional === undefined) throw new Error("osn-api production declares no optional secret");
    const env = Object.fromEntries(
      [...row.secrets, optional].map((name) => [name, "not-a-real-secret"]),
    );
    const props = apiWorkerProps({
      ...cireApiProduction,
      worker: "osn-api",
      name: "osn-api-production",
      main: "../../osn/api/src/index.ts",
      secrets: requireSecrets({ worker: "osn-api", stage: "production", env }),
    });
    const passed = (props.env as Record<string, unknown>)[optional];
    expect(Redacted.isRedacted(passed)).toBe(true);
  });

  test("refuses secrets that leave out a name the inventory requires, naming it", () => {
    const { CIRE_OIDC_CLIENT_SECRET: _dropped, ...secrets } = cireApiSecrets("dev");
    const error = thrown(() => apiWorkerProps({ ...cireApiDev, secrets }));
    expect(error).toBeInstanceOf(UndeclaredSecretsError);
    expect(error).toMatchObject({
      worker: "cire-api",
      tier: "dev",
      missing: ["CIRE_OIDC_CLIENT_SECRET"],
      unexpected: [],
    });
    expect((error as Error).message).not.toContain("not-a-real-secret");
  });

  test("refuses a secret the inventory does not declare for the Worker and tier, naming it", () => {
    const secrets = {
      ...cireApiSecrets("production"),
      STRIPE_SECRET_KEY: Redacted.make("not-a-real-secret"),
    };
    const error = thrown(() => apiWorkerProps({ ...cireApiProduction, secrets }));
    expect(error).toBeInstanceOf(UndeclaredSecretsError);
    expect(error).toMatchObject({
      worker: "cire-api",
      tier: "production",
      missing: [],
      unexpected: ["STRIPE_SECRET_KEY"],
    });
    expect((error as Error).message).not.toContain("not-a-real-secret");
  });

  test("I3: OSN_API_URL is a var on dev and a secret on production, never both", () => {
    expect(tierSecrets("cire-api", "dev").secrets).not.toContain("OSN_API_URL");
    const asSecret = {
      ...cireApiSecrets("dev"),
      OSN_API_URL: Redacted.make("https://osn.invalid"),
    };
    const error = thrown(() => apiWorkerProps({ ...cireApiDev, secrets: asSecret }));
    expect(error).toBeInstanceOf(UndeclaredSecretsError);
    expect(error).toMatchObject({ unexpected: ["OSN_API_URL"] });
    // The dev row lists it as a plain var, so the var passes there, and only
    // as a var: a binding of that name is still refused.
    const asVar = { ...cireApiDev.vars, OSN_API_URL: "https://id.musubi.example.test" };
    expect(apiWorkerProps({ ...cireApiDev, vars: asVar }).env).toMatchObject({
      OSN_API_URL: "https://id.musubi.example.test",
    });
    expect(() => apiWorkerProps({ ...cireApiDev, bindings: { OSN_API_URL: {} as never } })).toThrow(
      SecretAsPlainBindingError,
    );
    expect(() =>
      apiWorkerProps({
        ...cireApiProduction,
        vars: { ...cireApiProduction.vars, OSN_API_URL: "https://osn.invalid" },
      }),
    ).toThrow(BindingNameClashError);
  });

  test("leaves zone routes unmanaged", () => {
    expect(apiWorkerProps(cireApiDev)).not.toHaveProperty("routes");
  });

  test("B1: a prebuilt Worker reaches the props unbundled", () => {
    expect(apiWorkerProps({ ...cireApiDev, bundle: false }).bundle).toBe(false);
    expect(apiWorkerProps(cireApiDev).bundle).toBe(true);
  });

  test("B8: a bundled Worker keeps Alchemy's own externals and every Bun-only module out of its bundle; a prebuilt one passes no build options", () => {
    // An `input.external` override replaces the list Alchemy sets itself,
    // so the props must repeat it.
    const bundler = readFileSync(
      join(alchemyDir(), "src", "Cloudflare", "Workers", "Sources", "Rolldown.ts"),
      "utf8",
    );
    expect(bundler).toContain('external: ["lightningcss", "fsevents"],');
    expect(bundler).toContain("...overrides,");

    expect(apiWorkerProps(cireApiDev).build).toEqual({
      input: { external: ["lightningcss", "fsevents", "drizzle-orm/bun-sqlite"] },
    });
    expect(apiWorkerProps({ ...cireApiDev, bundle: false })).not.toHaveProperty("build");
  });

  test("B2: maps the assets config field for field, copying the routing rules", () => {
    const runWorkerFirst = ["/_server-islands/*", "!/_astro/*"];
    const props = apiWorkerProps({
      ...cireApiDev,
      assets: {
        directory: "../../cire/invites/dist/client",
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "404-page",
        runWorkerFirst,
      },
    });
    expect(props.assets).toEqual({
      directory: "../../cire/invites/dist/client",
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
      runWorkerFirst: ["/_server-islands/*", "!/_astro/*"],
    });
    expect((props.assets as { readonly runWorkerFirst?: unknown }).runWorkerFirst).not.toBe(
      runWorkerFirst,
    );
    const everyRequest = apiWorkerProps({
      ...cireApiDev,
      assets: {
        directory: "dist",
        htmlHandling: "none",
        notFoundHandling: "none",
        runWorkerFirst: true,
      },
    });
    expect(everyRequest.assets).toEqual({
      directory: "dist",
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: true,
    });
  });

  test("B3: a Worker with no assets declares no assets prop", () => {
    expect("assets" in apiWorkerProps(cireApiDev)).toBe(false);
  });
});

describe("siteWorkerProps", () => {
  const site = {
    name: "cire-landing",
    stage: "production",
    directory: "../../cire/landing/dist",
    domain: "cireweddings.com",
    workersDev: false,
    previewUrls: false,
    htmlHandling: "auto-trailing-slash",
    notFoundHandling: "404-page",
    issues: true,
    entry: null,
    redirectsFile: true,
  } as const;

  test("deploys assets only, with every routing choice stated", () => {
    const props = siteWorkerProps(site);
    expect(props).not.toHaveProperty("main");
    expect(props).not.toHaveProperty("env");
    expect(props.assets).toEqual({
      directory: "../../cire/landing/dist",
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
    });
    expect(props.workersDev).toEqual({ enabled: false, previewsEnabled: false });
    expect(siteWorkerProps({ ...site, stage: "dev", previewUrls: true }).workersDev).toEqual({
      enabled: false,
      previewsEnabled: true,
    });
    expect(() => siteWorkerProps({ ...site, previewUrls: true })).toThrow(
      ProductionPreviewUrlsError,
    );
  });

  test("B4: a site with an entry runs it before the assets it names; one without has no script", () => {
    const props = siteWorkerProps({
      ...site,
      name: "pulse-landing-dev",
      stage: "dev",
      directory: "../../pulse/landing/dist",
      entry: {
        main: "../../pulse/landing/worker/index.ts",
        compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
        runWorkerFirst: ["/api/geo"],
      },
    });
    expect(props.main).toBe("../../pulse/landing/worker/index.ts");
    expect(props.compatibility).toEqual({ date: "2026-10-01", flags: ["nodejs_compat"] });
    expect(props.assets).toEqual({
      directory: "../../pulse/landing/dist",
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
      runWorkerFirst: ["/api/geo"],
    });
    const assetsOnly = siteWorkerProps(site);
    expect(assetsOnly).not.toHaveProperty("main");
    expect(assetsOnly).not.toHaveProperty("compatibility");
  });

  test("B7: a site that turns its _redirects file off sends empty redirects; one that keeps it sends none", () => {
    expect(siteWorkerProps({ ...site, redirectsFile: false }).assets).toEqual({
      directory: "../../cire/landing/dist",
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
      redirects: "",
    });
    expect(siteWorkerProps(site).assets).not.toHaveProperty("redirects");
  });

  test("keeps query strings out of logs and native traces off on every stage", () => {
    // musubi social serves the OIDC authorize screen, whose URL carries OIDC parameters.
    for (const stage of ["dev", "production", "pr-7"]) {
      expect(siteWorkerProps({ ...site, stage }).observability).toEqual({
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: false },
        traces: { enabled: false },
        issues: { enabled: true },
      });
    }
  });
});
