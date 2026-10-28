#!/usr/bin/env bun
/**
 * The plan guard for the cire stack's production plan: `bun run plan:guard --
 * --log <alchemy log> --out <record.json> --domains <live domains.json>
 * [--flip <surface>] [--unflip <surface>] [--approved <record.json>]`.
 * `runPlanGuardCli` in @shared/infra holds the rules; this names the stack's
 * resources and sites.
 */
import { runPlanGuardCli } from "@shared/infra";

import { PRODUCTION_RESOURCE_KINDS, SITE_LOGICAL_IDS } from "../src/declaration";

process.exit(
  runPlanGuardCli({
    stack: "cire",
    kinds: PRODUCTION_RESOURCE_KINDS,
    sites: SITE_LOGICAL_IDS,
    argv: process.argv.slice(2),
    env: process.env,
    out: (text) => process.stdout.write(text),
  }),
);
