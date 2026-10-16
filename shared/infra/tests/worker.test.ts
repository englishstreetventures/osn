import { Redacted } from "effect";
import { describe, expect, test } from "vitest";

import {
  apiWorkerProps,
  BindingNameClashError,
  ProductionObservabilityError,
  siteWorkerProps,
  type ApiWorkerInput,
} from "../src/worker";

const cireApiDev: ApiWorkerInput = {
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
  secrets: { CIRE_OIDC_CLIENT_SECRET: Redacted.make("not-a-real-secret") },
  observability: {
    headSamplingRate: 1,
    redactQueryString: false,
    traces: { enabled: true, headSamplingRate: 1 },
  },
};

const cireApiProduction: ApiWorkerInput = {
  ...cireApiDev,
  name: "cire-api-production",
  stage: "production",
  domain: "api.cireweddings.com",
  observability: { headSamplingRate: 1, redactQueryString: true, traces: { enabled: false } },
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
    });
    const on = apiWorkerProps({
      ...cireApiDev,
      observability: { ...cireApiDev.observability, invocationLogs: true },
    });
    expect(on.observability?.logs).toEqual({ enabled: true, invocationLogs: true });
  });

  test("passes every var, binding and secret through env, secrets still redacted", () => {
    const env = apiWorkerProps(cireApiDev).env as Record<string, unknown>;
    expect(Object.keys(env).toSorted()).toEqual(["CIRE_OIDC_CLIENT_SECRET", "OSN_ENV"]);
    expect(Redacted.isRedacted(env.CIRE_OIDC_CLIENT_SECRET)).toBe(true);
  });

  test("refuses one name in two binding groups", () => {
    expect(() =>
      apiWorkerProps({ ...cireApiDev, vars: { CIRE_OIDC_CLIENT_SECRET: "plain" } }),
    ).toThrow(BindingNameClashError);
  });

  test("refuses a name Alchemy binds itself", () => {
    expect(() => apiWorkerProps({ ...cireApiDev, vars: { ALCHEMY_STAGE: "dev" } })).toThrow(
      /ALCHEMY_STAGE/,
    );
  });

  test("states the custom domain, or null to detach every one", () => {
    expect(apiWorkerProps(cireApiDev).domain).toBe("api.dev.cireweddings.com");
    expect(apiWorkerProps({ ...cireApiDev, domain: null }).domain).toBeNull();
  });

  test("copies compatibility flags and crons rather than sharing the caller's arrays", () => {
    const props = apiWorkerProps(cireApiDev);
    expect(props.compatibility).toEqual({
      date: "2025-03-01",
      flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
    });
    expect(props.compatibility?.flags).not.toBe(cireApiDev.compatibility.flags);
    expect(props.crons).toEqual(["0 4 * * *"]);
    expect(props.crons).not.toBe(cireApiDev.crons);
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
      });
    }
  });
});
