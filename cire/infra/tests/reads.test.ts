import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stageHosts, tierSecrets } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { cireDeclaration } from "../src/declaration";

const cireApiSource = fileURLToPath(new URL("../../api/src", import.meta.url));

/** `env.NAME`, `env?.NAME` and `env["NAME"]`, `process.env` included. */
const READ = /\benv\??\.([A-Z][A-Z0-9_]*)\b|\benv\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;

/**
 * Names cire-api's source reads that the dev stack deliberately leaves unset,
 * each with why.
 */
const UNSET_ON_DEV: Readonly<Record<string, string>> = {
  CIRE_DEV_OWNER_PROFILE_ID:
    "read only by src/local.ts, the Bun dev server; on dev the stack seeds the owner seat from it instead",
  CIRE_E2E_CLIENT_ADDRESS:
    "read only by src/local.ts, the Bun dev server, which keeps a request's client address for the E2E suite",
  CIRE_E2E_ORGANISER:
    "read only through src/local.ts, the Bun dev server, to seed the E2E suite's organiser",
  CIRE_E2E_REGISTRY:
    "read only through src/local.ts, the Bun dev server, to seed the E2E suite's gift-list wedding",
  CIRE_E2E_RSVP_DEADLINE:
    "read only through src/local.ts, the Bun dev server, to give the E2E suite's sample wedding its RSVP deadline",
  CIRE_INTERNAL_REVOKE_SECRET:
    "unset, the back-channel revoke route answers 503 (index.ts); the inventory declares it on neither tier",
  CIRE_LOCAL_DB_PATH: "read only by src/local.ts, the Bun dev server",
  CIRE_OPS_EMAIL:
    "unset, no vendor-claim reminder is sent (lib/claim-review-email.ts); the inventory declares it on neither tier",
  GROWTHBOOK_CLIENT_KEY: "dev has no GrowthBook key; every flag serves its coded default",
  KV_GB_PAYLOAD:
    "the optional GrowthBook payload cache; no tier binds it, and each isolate caches its own",
  PORT: "read only by src/local.ts, the Bun dev server",
  RESEND_API_KEY:
    "unset, email goes to the log transport (index.ts); the inventory declares it on neither tier",
  RESEND_API_URL:
    "the local Resend emulator's origin; a deployed tier refuses it (lib/resend-email.ts), and the inventory forbids it on both tiers",
  STRIPE_ACCOUNT_COUNTRY:
    "the optional default country for Connect onboarding; production sets none either",
  STRIPE_UPGRADE_PRICE_CRIMSON:
    "unset until the Stripe Prices exist, so nothing is for sale; production sets none either",
  STRIPE_UPGRADE_PRICE_CRIMSON_FROM_GOLD: "the same: unset until the Stripe Prices exist",
  STRIPE_UPGRADE_PRICE_GOLD: "the same: unset until the Stripe Prices exist",
  TURNSTILE_SECRET_KEY:
    "key-optional: unset, the Turnstile gate does not verify; the inventory declares it on neither tier",
  ZAP_API_URL:
    "dev does not call zap: unset, the enquiry chat bridge is off and no vendor mail is sent (index.ts)",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("what cire-api reads on dev", () => {
  test("K9: every env name cire-api's source reads is declared, or deliberately unset with a reason", () => {
    const read = new Set(
      sourceFiles(cireApiSource).flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(READ)].map((match) => match[1] ?? match[2] ?? ""),
      ),
    );
    const declared = cireDeclaration({
      stage: "dev",
      hosts: stageHosts("example.test", "dev"),
      generatedDir: ".generated",
      ownerSeat: false,
    }).cireApi;
    const secrets = tierSecrets("cire-api", "dev");
    const onDev = new Set([
      ...Object.keys(declared.vars),
      ...Object.keys(declared.bindings),
      ...secrets.secrets,
      ...secrets.optional,
    ]);

    expect([...read].filter((name) => !onDev.has(name)).toSorted()).toEqual(
      Object.keys(UNSET_ON_DEV).toSorted(),
    );
  });
});
