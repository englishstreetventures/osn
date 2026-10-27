#!/usr/bin/env bun
/**
 * Writes the origin each production site's Worker serves at its mode in
 * PRODUCTION_SITE_MODES: `bun run production-hosts`. One
 * `<surface>_origin=https://<host>` line per non-off site to
 * `$GITHUB_OUTPUT` (stdout when unset), the values the production stack
 * job's smoke checks read, as dev's read the `dev-hosts` step's.
 */
import { appendFileSync } from "node:fs";

import { productionHostOutputs } from "../src/production-sites";

const lines = [...productionHostOutputs()].map(([key, value]) => `${key}=${value}\n`).join("");
const outputFile = process.env.GITHUB_OUTPUT ?? "";
if (outputFile === "") process.stdout.write(lines);
else appendFileSync(outputFile, lines);
