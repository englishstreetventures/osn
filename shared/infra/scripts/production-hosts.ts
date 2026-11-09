#!/usr/bin/env bun
/**
 * Writes the origin each production site's Worker serves at its mode in
 * PRODUCTION_SITE_MODES, and on a flip release the CNAME its deploy
 * replaces: `bun run production-hosts`, with FLIP the plan job's `flip`
 * output (empty or unset on any other release). One
 * `<surface>_origin=https://<host>` line per non-off site, and one
 * `replace_cname=` line, `<host>=<project>.pages.dev` on a flip and empty
 * otherwise, to `$GITHUB_OUTPUT` (stdout when unset): the values the
 * production stack job's smoke checks and deploy, and the verify job's
 * record check, read, as dev's read the `dev-hosts` step's.
 *
 * Exit 1, writing nothing, when FLIP names no site or a site no flip moves.
 */
import { appendFileSync } from "node:fs";

import {
  productionHostOutputs,
  PRODUCTION_SITE_MODES,
  SITE_SURFACES,
  type SiteSurface,
} from "../src/production-sites";

const flip = (process.env.FLIP ?? "").trim();
const isSite = (value: string): value is SiteSurface =>
  SITE_SURFACES.some((site) => site === value);
if (flip !== "" && !isSite(flip)) {
  process.stderr.write(`::error::production-hosts: FLIP names '${flip}', which is not a site.\n`);
  process.exit(1);
}
let outputs: ReadonlyMap<string, string>;
try {
  outputs = productionHostOutputs(PRODUCTION_SITE_MODES, flip);
} catch (failure) {
  process.stderr.write(
    `::error::production-hosts: ${failure instanceof Error ? failure.message : String(failure)}\n`,
  );
  process.exit(1);
}
const lines = [...outputs].map(([key, value]) => `${key}=${value}\n`).join("");
const outputFile = process.env.GITHUB_OUTPUT ?? "";
if (outputFile === "") process.stdout.write(lines);
else appendFileSync(outputFile, lines);
