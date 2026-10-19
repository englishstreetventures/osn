import { Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { tierSecrets } from "../src/secrets/inventory";
import { requireSecrets } from "../src/secrets/require";
import type { Tier } from "../src/stage";
import {
  apiWorkerProps,
  BindingNameClashError,
  ProductionObservabilityError,
  siteWorkerProps,
  UndeclaredSecretsError,
  type ApiWorkerInput,
} from "../src/worker";

/** Every secret the inventory requires of cire-api on `tier`, each with a placeholder value. */
const cireApiSecrets = (tier: Tier): Record<string, Redacted.Redacted<string>> =>
  Object.fromEntries(
    tierSecrets("cire-api", tier).secrets.map((name) => [name, Redacted.make("not-a-real-secret")]),
  );

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
  compatibility: {
    date: "2025-03-01",
    flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
  },
  domain: "api.dev.cireweddings.com",
  crons: ["0 4 * * *"],
  workersDev: false,
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
  test("turns version preview URLs off on production only", () => {
    expect(apiWorkerProps(cireApiDev).workersDev).toEqual({
      enabled: false,
      previewsEnabled: true,
    });
    expect(apiWorkerProps({ ...cireApiDev, stage: "pr-7" }).workersDev).toEqual({
      enabled: false,
      previewsEnabled: true,
    });
    expect(apiWorkerProps(cireApiProduction).workersDev).toEqual({
      enabled: false,
      previewsEnabled: false,
    });
    expect(apiWorkerProps({ ...cireApiDev, workersDev: true }).workersDev).toEqual({
      enabled: true,
      previewsEnabled: true,
    });
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

  test("leaves zone routes unmanaged", () => {
    expect(apiWorkerProps(cireApiDev)).not.toHaveProperty("routes");
  });
});

describe("siteWorkerProps", () => {
  const site = {
    name: "cire-landing",
    stage: "production",
    directory: "../../cire/landing/dist",
    domain: "cireweddings.com",
    workersDev: false,
    htmlHandling: "auto-trailing-slash",
    notFoundHandling: "404-page",
    issues: true,
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
    expect(siteWorkerProps({ ...site, stage: "dev" }).workersDev).toEqual({
      enabled: false,
      previewsEnabled: true,
    });
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
