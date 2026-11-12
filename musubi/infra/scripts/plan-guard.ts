#!/usr/bin/env bun
/**
 * The plan guard for the musubi stack's production plan: `bun run
 * plan:guard -- --log <alchemy log> --out <record.json> --domains <live
 * domains.json> [--approved <record.json>]`. `runPlanGuardCli` in
 * @shared/infra holds the rules; this names the stack's resources and the
 * host its declaration gives each site's Worker.
 */
import { runPlanGuardCli } from "@shared/infra";

import { PRODUCTION_RESOURCE_KINDS, PRODUCTION_SITE_DOMAINS } from "../src/declaration";

process.exit(
  runPlanGuardCli({
    stack: "musubi",
    kinds: PRODUCTION_RESOURCE_KINDS,
    declared: PRODUCTION_SITE_DOMAINS,
    argv: process.argv.slice(2),
    env: process.env,
    out: (text) => process.stdout.write(text),
  }),
);
