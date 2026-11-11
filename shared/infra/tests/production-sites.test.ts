import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { hostsFor, PRODUCTION_ZONES, stageHosts } from "../src/hosts";
import {
  heldHost,
  HOST_HOLDS_FILE,
  type HostHold,
  PRODUCTION_ADOPTIONS,
  PRODUCTION_HOST_HOLDS,
  PRODUCTION_HOSTS,
  PRODUCTION_SITE_MODES,
  productionHost,
  productionHostOutputs,
  SITE_BUILDS,
  SITE_SURFACES,
  siteDomain,
  zoneOf,
} from "../src/production-sites";

const source = readFileSync(
  fileURLToPath(new URL("../src/production-sites.ts", import.meta.url)),
  "utf8",
);

/** A hold on cire vendor's host, as an entry in PRODUCTION_HOST_HOLDS reads. */
const VENDOR_HELD: readonly HostHold[] = [
  {
    site: "cire_vendor",
    host: "vendor.cireweddings.com",
    reason: "Serves nothing until the vendor export ships.",
  },
];

describe("production-sites.ts", () => {
  test("PS1: imports nothing, so scripts that install nothing can load it, and names its own path for the refusals that cite it", () => {
    expect(source).not.toMatch(/^\s*import\b|\brequire\(|\bimport\(/m);
    expect(source).not.toMatch(/^\s*export\s+\*?\s*\{?[^;]*\bfrom\b/m);
    expect(
      fileURLToPath(new URL("../src/production-sites.ts", import.meta.url)).endsWith(
        `/${HOST_HOLDS_FILE}`,
      ),
    ).toBe(true);
  });

  test("PS2: no production API Worker, database or bucket is adopted", () => {
    expect(PRODUCTION_ADOPTIONS).toEqual([]);
  });

  test("PS3: every site but pulse landing serves its host from its Worker, pulse landing is off", () => {
    expect(PRODUCTION_SITE_MODES).toEqual({
      cire_host: "worker",
      cire_vendor: "worker",
      cire_landing: "worker",
      osn_social: "worker",
      musubi_landing: "worker",
      pulse_landing: "off",
    });
    expect(Object.keys(PRODUCTION_SITE_MODES).toSorted()).toEqual([...SITE_SURFACES].toSorted());
  });

  test("PS4: a worker serves its production host, an off site none, and a held site none", () => {
    expect(siteDomain("cire_host", "worker", [])).toBe("host.cireweddings.com");
    expect(siteDomain("musubi_landing", "worker", [])).toBe("www.musubi.social");
    expect(siteDomain("cire_landing", "off", [])).toBeNull();
    expect(siteDomain("cire_vendor", "worker", VENDOR_HELD)).toBeNull();
    // A hold on one site leaves every other site its host.
    expect(siteDomain("cire_host", "worker", VENDOR_HELD)).toBe("host.cireweddings.com");
    expect(heldHost("cire_vendor", VENDOR_HELD)).toEqual(VENDOR_HELD[0]);
    expect(heldHost("cire_host", VENDOR_HELD)).toBeUndefined();
  });

  test("PS5: every site host sits in its production zone, and each build writes its workspace's dist", () => {
    for (const surface of SITE_SURFACES) {
      const host = productionHost(surface);
      expect({ host, zone: PRODUCTION_ZONES.includes(zoneOf(host)) }).toEqual({ host, zone: true });
    }
    // Each workspace `@<product>/<name>` lives in `<product>/<name>` and builds into `dist`.
    for (const surface of SITE_SURFACES) {
      const build = SITE_BUILDS[surface];
      expect(build.directory).toBe(`${build.package.slice(1)}/dist`);
    }
  });

  test("production-hosts names each non-off site's production origin, held or not, the origin its smoke check probes", () => {
    expect(Object.fromEntries(productionHostOutputs())).toEqual({
      cire_host_origin: "https://host.cireweddings.com",
      cire_vendor_origin: "https://vendor.cireweddings.com",
      cire_landing_origin: "https://cireweddings.com",
      osn_social_origin: "https://musubi.social",
      musubi_landing_origin: "https://www.musubi.social",
    });
    // An off site has none.
    const outputs = Object.fromEntries(
      productionHostOutputs({ ...PRODUCTION_SITE_MODES, osn_social: "off" }),
    );
    expect(outputs.osn_social_origin).toBeUndefined();
    expect(outputs.cire_landing_origin).toBe("https://cireweddings.com");
  });

  test("PS6: production runs on today's production hosts and reads no DEV_DOMAIN; every other stage derives its own", () => {
    expect(hostsFor("production", {})).toEqual(PRODUCTION_HOSTS);
    expect(Object.keys(PRODUCTION_HOSTS).toSorted()).toEqual(
      Object.keys(stageHosts("example.test", "dev")).toSorted(),
    );
    expect(hostsFor("dev", { DEV_DOMAIN: "example.test" })).toEqual(
      stageHosts("example.test", "dev"),
    );
    expect(hostsFor("pr-7", { DEV_DOMAIN: "example.test" })).toEqual(
      stageHosts("example.test", "pr-7"),
    );
    expect(() => hostsFor("dev", {})).toThrow(/DEV_DOMAIN/);
  });
});

describe("PS7: each production host hold", () => {
  // Read on every entry the owner adds: these hold the list's shape, never
  // its contents, so a pull request that adds or removes an entry passes.
  test("names a site whose Worker serves its host, and that site's production host", () => {
    for (const hold of PRODUCTION_HOST_HOLDS) {
      expect({ hold, mode: PRODUCTION_SITE_MODES[hold.site] }).toEqual({ hold, mode: "worker" });
      expect({ hold, host: productionHost(hold.site) }).toEqual({ hold, host: hold.host });
    }
  });

  test("holds each site once", () => {
    const sites = PRODUCTION_HOST_HOLDS.map((hold) => hold.site);
    expect(new Set(sites).size).toBe(sites.length);
  });

  test("gives a reason of one line that names no issue or finding", () => {
    for (const hold of PRODUCTION_HOST_HOLDS) {
      expect({ hold, ok: reasonProblem(hold.reason) }).toEqual({ hold, ok: undefined });
    }
  });

  test("the reason check refuses an empty, long or multi-line reason, and one that names an issue or finding", () => {
    expect(reasonProblem("Serves nothing until the vendor export ships.")).toBeUndefined();
    for (const bad of [
      "",
      "   ",
      "two\nlines",
      "x".repeat(161),
      "See #412.",
      "englishstreetventures/osn-tracker#9",
      "S-H2 is open",
      "P-W1",
      "C-M3",
    ]) {
      expect({ bad, problem: reasonProblem(bad) === undefined }).toEqual({ bad, problem: false });
    }
  });
});

/** Why `reason` is not a hold's reason, or undefined when it is one. */
function reasonProblem(reason: string): string | undefined {
  if (reason.trim() === "") return "empty";
  if (/[\r\n]/.test(reason)) return "more than one line";
  if (reason.length > 160) return "longer than 160 characters";
  if (/#\d|osn-tracker|\b[SPC]-[A-Z]{1,2}\d/.test(reason)) return "names an issue or finding";
  return undefined;
}
