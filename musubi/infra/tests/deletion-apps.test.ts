import { PRODUCTION_STAGE_HOSTS, stageHosts, type StageHosts } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { DELETION_APP_HOSTS, musubiDeclaration, musubiProductionApis } from "../src/declaration";

/**
 * osn-api's account deletion must reach every app a tier runs: on dev and on
 * production, each app with an API Worker gets that Worker's origin, and each
 * app with none is declared absent, so osn-api skips it rather than holding
 * every deletion. When an app gains an API host, this fails until osn-api is
 * given its address.
 */

const URL_VARS = { pulse: "PULSE_API_URL", zap: "ZAP_API_URL", cire: "CIRE_API_URL" } as const;

/** The `StageHosts` key an app's API Worker would have. */
const API_HOST_KEYS = { pulse: "pulseApi", zap: "zapApi", cire: "cireApi" } as const;

const APPS = ["pulse", "zap", "cire"] as const;

const tiers: ReadonlyArray<readonly [string, StageHosts, Readonly<Record<string, string>>]> = [
  [
    "dev",
    stageHosts("example.test", "dev"),
    musubiDeclaration({
      stage: "dev",
      hosts: stageHosts("example.test", "dev"),
      generatedDir: ".generated",
    }).osnApi.vars,
  ],
  [
    "production",
    PRODUCTION_STAGE_HOSTS,
    musubiProductionApis({ hosts: PRODUCTION_STAGE_HOSTS, generatedDir: ".generated" }).osnApi.vars,
  ],
];

describe("where osn-api's account deletion reaches each app", () => {
  test.each(tiers)(
    "on %s, every app has its API origin or is declared absent",
    (_tier, hosts, vars) => {
      const absent = new Set((vars.OSN_DELETION_ABSENT_APPS ?? "").split(",").filter(Boolean));
      const found = APPS.map((app) => ({
        app,
        url: vars[URL_VARS[app]],
        absent: absent.has(app),
      }));
      const expected = APPS.map((app) => {
        const host = (hosts as unknown as Readonly<Record<string, string | undefined>>)[
          API_HOST_KEYS[app]
        ];
        // No API Worker for the app on this tier: no address, and skipped.
        return host === undefined
          ? { app, url: undefined, absent: true }
          : { app, url: `https://${host}`, absent: false };
      });
      expect(found).toEqual(expected);
    },
  );

  test("the declared app list names exactly the apps osn-api's deletion reaches", () => {
    expect(Object.keys(DELETION_APP_HOSTS).toSorted()).toEqual(Object.keys(URL_VARS).toSorted());
  });

  test("zap-api and cire-api run on dev and production, so neither may skip them", () => {
    for (const [, , vars] of tiers) {
      expect(vars.ZAP_API_URL).toMatch(/^https:\/\//);
      expect(vars.CIRE_API_URL).toMatch(/^https:\/\//);
      expect(vars.OSN_DELETION_ABSENT_APPS ?? "").not.toContain("zap");
      expect(vars.OSN_DELETION_ABSENT_APPS ?? "").not.toContain("cire");
    }
  });
});
