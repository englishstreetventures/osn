import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { hostsFor, PRODUCTION_ZONES, stageHosts } from "../src/hosts";
import {
  PAGES_PROJECTS,
  PRODUCTION_ADOPTIONS,
  PRODUCTION_HOSTS,
  PRODUCTION_SITE_MODES,
  PRODUCTION_STAGING_HOSTS,
  productionHost,
  productionHostOutputs,
  SITE_BUILDS,
  SITE_SURFACES,
  siteDomain,
  SiteModeError,
  zoneOf,
} from "../src/production-sites";

const source = readFileSync(
  fileURLToPath(new URL("../src/production-sites.ts", import.meta.url)),
  "utf8",
);

describe("production-sites.ts", () => {
  test("PS1: imports nothing, so scripts that install nothing can load it", () => {
    expect(source).not.toMatch(/^\s*import\b|\brequire\(|\bimport\(/m);
    expect(source).not.toMatch(/^\s*export\s+\*?\s*\{?[^;]*\bfrom\b/m);
  });

  test("PS2: no production API Worker, database or bucket is adopted", () => {
    expect(PRODUCTION_ADOPTIONS).toEqual([]);
  });

  test("PS3: the four Pages sites are staged, musubi landing serves its host, pulse landing is off", () => {
    expect(PRODUCTION_SITE_MODES).toEqual({
      cire_host: "staged",
      cire_vendor: "staged",
      cire_landing: "staged",
      osn_social: "staged",
      musubi_landing: "worker",
      pulse_landing: "off",
    });
    expect(Object.keys(PRODUCTION_SITE_MODES).toSorted()).toEqual([...SITE_SURFACES].toSorted());
    // Only a site a Pages project serves today can be staged beside it.
    const staged = SITE_SURFACES.filter((surface) => PRODUCTION_SITE_MODES[surface] === "staged");
    expect(staged.filter((surface) => PAGES_PROJECTS[surface] === undefined)).toEqual([]);
  });

  test("PS4: a staged site serves its spare host, a worker its production host, an off site none; a staged site with no spare host is refused", () => {
    expect(siteDomain("cire_host", "staged")).toBe("next-host.cireweddings.com");
    expect(siteDomain("osn_social", "staged")).toBe("next.musubi.social");
    expect(siteDomain("cire_host", "worker")).toBe("host.cireweddings.com");
    expect(siteDomain("musubi_landing", "worker")).toBe("www.musubi.social");
    expect(siteDomain("cire_landing", "off")).toBeNull();
    for (const surface of ["musubi_landing", "pulse_landing"] as const) {
      expect(() => siteDomain(surface, "staged")).toThrow(SiteModeError);
      expect(() => siteDomain(surface, "staged")).toThrow(/no spare host/);
    }
    // Every mode the switch sets is one the site can serve.
    for (const surface of SITE_SURFACES) {
      expect(() => siteDomain(surface, PRODUCTION_SITE_MODES[surface])).not.toThrow();
    }
  });

  test("PS5: every site host sits in its production zone, and no spare host is a production host", () => {
    const production = new Set<string>(Object.values(PRODUCTION_HOSTS));
    for (const surface of SITE_SURFACES) {
      const host = productionHost(surface);
      expect({ host, zone: PRODUCTION_ZONES.includes(zoneOf(host)) }).toEqual({ host, zone: true });
      const staging = PRODUCTION_STAGING_HOSTS[surface];
      if (staging === undefined) continue;
      expect({ staging, zone: zoneOf(staging) }).toEqual({ staging, zone: zoneOf(host) });
      expect(production.has(staging)).toBe(false);
    }
    expect(new Set(Object.values(PRODUCTION_STAGING_HOSTS)).size).toBe(
      Object.values(PRODUCTION_STAGING_HOSTS).length,
    );
    // Each workspace `@<product>/<name>` lives in `<product>/<name>` and builds into `dist`.
    for (const surface of SITE_SURFACES) {
      const build = SITE_BUILDS[surface];
      expect(build.directory).toBe(`${build.package.slice(1)}/dist`);
    }
  });

  test("production-hosts names each non-off site's origin at its mode, the origin its smoke check probes", () => {
    expect(Object.fromEntries(productionHostOutputs())).toEqual({
      cire_host_origin: "https://next-host.cireweddings.com",
      cire_vendor_origin: "https://next-vendor.cireweddings.com",
      cire_landing_origin: "https://next.cireweddings.com",
      osn_social_origin: "https://next.musubi.social",
      musubi_landing_origin: "https://www.musubi.social",
    });
    expect(
      Object.fromEntries(
        productionHostOutputs({ ...PRODUCTION_SITE_MODES, cire_host: "worker", osn_social: "off" }),
      ),
    ).toMatchObject({ cire_host_origin: "https://host.cireweddings.com" });
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
