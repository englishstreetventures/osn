// The domain move rehearsal's names: the two hosts it moves between, the
// Worker and Pages project it makes, and the marker pages each serves. The
// workflow (.github/workflows/domain-move-rehearsal.yml) and its script
// (scripts/domain-move-rehearsal.ts) act on these names alone, so a wrong one
// here is a run that touches a host or resource that is not the rehearsal's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  REHEARSAL_MARKERS,
  REHEARSAL_PROJECT_PREFIX,
  REHEARSAL_STAGE,
  REHEARSAL_WORKER,
  RehearsalNameError,
  rehearsalDomain,
  rehearsalHosts,
  rehearsalProductionZones,
  rehearsalProject,
} from "../../rehearsal/names";
import { rehearsalWorkerInput } from "../../rehearsal/worker-input";
import { PRODUCTION_ZONES, stageHosts } from "../../src/hosts";
import { removalFor } from "../../src/removal";
import { parseStage, tierOf } from "../../src/stage";
import { siteWorkerProps } from "../../src/worker";

const DEV_DOMAIN = "example.dev";

describe("rehearsalHosts", () => {
  test("H1: the moved host is one label under the dev zone and the spare two, in the zone DEV_DOMAIN names", () => {
    expect(rehearsalHosts(DEV_DOMAIN)).toEqual({
      zone: "example.dev",
      host: "domain-move.example.dev",
      spare: "next.domain-move.example.dev",
    });
    // A dev domain of three labels is still the zone itself, never its last two labels.
    expect(rehearsalHosts("dev.example.co.uk")).toEqual({
      zone: "dev.example.co.uk",
      host: "domain-move.dev.example.co.uk",
      spare: "next.domain-move.dev.example.co.uk",
    });
  });

  test("H1: neither host is one a dev stack serves", () => {
    const { host, spare } = rehearsalHosts(DEV_DOMAIN);
    const dev = Object.values(stageHosts(DEV_DOMAIN, "dev"));
    expect(dev).not.toContain(host);
    expect(dev).not.toContain(spare);
    for (const devHost of dev) {
      expect(host.endsWith(`.${devHost}`)).toBe(false);
      expect(spare.endsWith(`.${devHost}`)).toBe(false);
    }
  });

  test.each([
    "cireweddings.com",
    "musubi.social",
    "pulse.events",
    "dev.cireweddings.com",
    "x.musubi.social",
    "workers.dev",
    "me.workers.dev",
    "me.pages.dev",
    "localhost",
    "Example.dev",
    "example.dev.",
    "https://example.dev",
    "",
  ])("H1: refuses %j as a dev domain", (raw) => {
    expect(() => rehearsalHosts(raw)).toThrow(RehearsalNameError);
  });

  test("H2: the production zones it refuses are exactly hosts.ts's PRODUCTION_ZONES", () => {
    expect([...rehearsalProductionZones()].toSorted()).toEqual([...PRODUCTION_ZONES].toSorted());
  });
});

describe("the rehearsal Worker", () => {
  const hosts = rehearsalHosts(DEV_DOMAIN);

  test("H3: staged serves the spare host, worker the moved host, under the one Worker name the destroy fallback deletes", () => {
    expect(rehearsalDomain(hosts, "staged")).toBe(hosts.spare);
    expect(rehearsalDomain(hosts, "worker")).toBe(hosts.host);
    for (const mode of ["staged", "worker"] as const) {
      const input = rehearsalWorkerInput({ stage: REHEARSAL_STAGE, hosts, mode });
      expect(input.name).toBe(REHEARSAL_WORKER);
      expect(input.domain).toBe(rehearsalDomain(hosts, mode));
      const props = siteWorkerProps(input);
      expect(props.name).toBe(REHEARSAL_WORKER);
      expect(props.domain).toBe(rehearsalDomain(hosts, mode));
      // An assets-only site, reachable at its custom domain alone.
      expect(props.main).toBeUndefined();
      expect(props.workersDev).toEqual({ enabled: false, previewsEnabled: false });
      expect(props.assets).toEqual({
        directory: "rehearsal/worker",
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "none",
      });
    }
  });

  test("H4: the stage is an investigation stage on the dev tier, whose Worker is destroyed with it", () => {
    expect(parseStage(REHEARSAL_STAGE)).toBe(REHEARSAL_STAGE);
    expect(tierOf(REHEARSAL_STAGE)).toBe("dev");
    expect(removalFor("worker", REHEARSAL_STAGE)).toBe("destroy");
  });
});

describe("the marker pages", () => {
  const page = (dir: string) =>
    readFileSync(
      fileURLToPath(new URL(`../../rehearsal/${dir}/index.html`, import.meta.url)),
      "utf8",
    );

  test("H5: each page holds its own marker and not the other's", () => {
    expect(page("pages")).toContain(REHEARSAL_MARKERS.pages);
    expect(page("pages")).not.toContain(REHEARSAL_MARKERS.worker);
    expect(page("worker")).toContain(REHEARSAL_MARKERS.worker);
    expect(page("worker")).not.toContain(REHEARSAL_MARKERS.pages);
    // Neither marker contains the other, so a body holds one at most.
    expect(REHEARSAL_MARKERS.pages.includes(REHEARSAL_MARKERS.worker)).toBe(false);
    expect(REHEARSAL_MARKERS.worker.includes(REHEARSAL_MARKERS.pages)).toBe(false);
  });
});

describe("rehearsalProject", () => {
  test("H6: one Pages project per run, under the prefix the cleanup sweeps", () => {
    expect(rehearsalProject("41818903897")).toBe(`${REHEARSAL_PROJECT_PREFIX}41818903897`);
    expect(rehearsalProject("41818903897").length).toBeLessThanOrEqual(58);
  });

  test.each(["", "12a", "-1", "1 2", "1".repeat(60)])("H6: refuses run id %j", (runId) => {
    expect(() => rehearsalProject(runId)).toThrow(RehearsalNameError);
  });
});
