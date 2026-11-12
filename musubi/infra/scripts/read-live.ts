#!/usr/bin/env bun
/**
 * Reads what the musubi stack's adopted production resources hold live, for the
 * plan guard and the check after a deploy: `bun run read:live -- --out
 * <live.json> [--kept <before.json>]`, with the production account's
 * CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. `runReadLiveCli`, from
 * `@shared/infra`, holds the rules; this names the stack's adopted resources.
 */
import { runReadLiveCli } from "@shared/infra";

import { PRODUCTION_ADOPTED } from "../src/declaration";

process.exit(
  await runReadLiveCli({
    adopted: PRODUCTION_ADOPTED,
    argv: process.argv.slice(2),
    env: process.env,
    fetch,
    sleep: (ms) => Bun.sleep(ms),
    out: (text) => process.stdout.write(text),
  }),
);
