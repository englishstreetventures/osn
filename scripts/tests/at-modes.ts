// The surface map and the release planner at site modes no commit holds.
//
// scripts/deploy-surfaces.ts builds its map from PRODUCTION_SITE_MODES as it
// loads, and the planner reads that map, so no argument sets a site's mode.
// A test that needs one (a staged site, once production stages none) loads
// copies of production-sites.ts, its modes replaced, and of the map, the
// planner and the fake GitHub as they are, from a temporary tree that keeps
// their relative paths, so the copies import one another.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type PerSite,
  PRODUCTION_SITE_MODES,
  type SiteMode,
} from "../../shared/infra/src/production-sites";

const ROOT = join(import.meta.dir, "..", "..");

const SITES_FILE = "shared/infra/src/production-sites.ts";
const FILES = [
  SITES_FILE,
  "scripts/deploy-surfaces.ts",
  "scripts/release-plan.ts",
  "scripts/tests/fake-github.ts",
] as const;

const MODES = /export const PRODUCTION_SITE_MODES: PerSite<SiteMode> = \{[^}]*\};/;

export interface AtModes {
  readonly sites: typeof import("../../shared/infra/src/production-sites");
  readonly surfaces: typeof import("../deploy-surfaces");
  readonly planner: typeof import("../release-plan");
  readonly github: typeof import("./fake-github");
}

const loaded = new Map<string, Promise<AtModes>>();

async function load(modes: PerSite<SiteMode>): Promise<AtModes> {
  const dir = mkdtempSync(join(tmpdir(), "at-modes-"));
  try {
    for (const file of FILES) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const copy =
        file === SITES_FILE
          ? text.replace(
              MODES,
              `export const PRODUCTION_SITE_MODES: PerSite<SiteMode> = ${JSON.stringify(modes)};`,
            )
          : text;
      if (file === SITES_FILE && copy === text) {
        throw new Error(
          `at-modes: ${SITES_FILE} no longer declares PRODUCTION_SITE_MODES as ${MODES}`,
        );
      }
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), copy);
    }
    const [sites, surfaces, planner, github] = await Promise.all([
      import(join(dir, FILES[0])) as Promise<AtModes["sites"]>,
      import(join(dir, FILES[1])) as Promise<AtModes["surfaces"]>,
      import(join(dir, FILES[2])) as Promise<AtModes["planner"]>,
      import(join(dir, FILES[3])) as Promise<AtModes["github"]>,
    ]);
    // The copy must hold the modes asked for, or a test meant for them would
    // pass at production's own.
    if (JSON.stringify(sites.PRODUCTION_SITE_MODES) !== JSON.stringify(modes)) {
      throw new Error("at-modes: the copied production-sites.ts did not take the modes asked for");
    }
    return { sites, surfaces, planner, github };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The map, the planner and the fake GitHub with `overrides` laid over production's modes. */
export function atModes(overrides: Partial<PerSite<SiteMode>>): Promise<AtModes> {
  const modes: PerSite<SiteMode> = { ...PRODUCTION_SITE_MODES, ...overrides };
  const key = JSON.stringify(modes);
  const found = loaded.get(key);
  if (found !== undefined) return found;
  const made = load(modes);
  loaded.set(key, made);
  return made;
}
