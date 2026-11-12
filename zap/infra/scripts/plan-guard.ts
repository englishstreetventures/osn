#!/usr/bin/env bun
/**
 * The plan guard for the zap stack's production plan: `bun run plan:guard --
 * --log <alchemy log> --out <record.json> --domains <live domains.json>
 * --live <live.json> [--approved <record.json>] [--scheduled]`.
 * `runPlanGuardCli` in @shared/infra holds the rules; this names the stack's
 * resources, the host its declaration gives each Worker, and its adopted
 * resources as declared.
 */
import { runPlanGuardCli } from "@shared/infra";

import {
  PRODUCTION_ADOPTED,
  PRODUCTION_DOMAINS,
  PRODUCTION_RESOURCE_KINDS,
} from "../src/declaration";

process.exit(
  runPlanGuardCli({
    stack: "zap",
    kinds: PRODUCTION_RESOURCE_KINDS,
    declared: PRODUCTION_DOMAINS,
    adopted: PRODUCTION_ADOPTED,
    argv: process.argv.slice(2),
    env: process.env,
    out: (text) => process.stdout.write(text),
  }),
);
