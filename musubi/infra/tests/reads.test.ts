import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stageHosts, tierSecrets } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { musubiDeclaration } from "../src/declaration";

const osnApiSource = fileURLToPath(new URL("../../../osn/api/src", import.meta.url));

/** `env.NAME`, `env?.NAME` and `env["NAME"]`, `process.env` included. */
const READ = /\benv\??\.([A-Z][A-Z0-9_]*)\b|\benv\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;

/**
 * Names osn-api's source reads that the dev stack deliberately leaves unset,
 * each with why, checked at the read site.
 */
const UNSET_ON_DEV: Readonly<Record<string, string>> = {
  CLOUDFLARE_ACCOUNT_ID:
    "the Cloudflare Email Service fallback (lib/email-layer.ts); Resend is the transport whenever RESEND_API_KEY is set, and it is required",
  CLOUDFLARE_EMAIL_API_TOKEN: "the same Cloudflare Email Service fallback",
  NODE_ENV: "read only by src/local.ts, the Bun dev server",
  OSN_ACCESS_TOKEN_TTL: "defaults to 300 seconds (build-deps.ts); production sets none either",
  OSN_ARC_KEY_ROTATION_BUFFER_HOURS:
    "defaults to 2 hours (lib/outbound-arc.ts); production sets none either",
  OSN_ARC_KEY_TTL_HOURS: "defaults to 24 hours (lib/outbound-arc.ts); production sets none either",
  OSN_DELETION_SWEEPER_INTERVAL_MS:
    "read only by src/local.ts; the Worker sweeps on its cron instead",
  OSN_REFRESH_TOKEN_TTL: "defaults to 30 days (build-deps.ts); production sets none either",
  OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS:
    "dev is on Workers Free: unset, the sweep keeps its default of 10 chunks (services/auth/tokens.ts), inside the 50 D1 queries one cron run may make",
  PORT: "read only by src/local.ts, the Bun dev server",
  PULSE_API_URL: "a deletion fan-out target; dev runs no pulse-api",
  RESEND_API_URL:
    "the local Resend emulator's origin; a deployed tier refuses to boot with it, and the inventory forbids it on dev",
  TRUSTED_PROXY_COUNT:
    "ignored on Workers, which key per-IP limits on cf-connecting-ip (build-deps.ts)",
  TURNSTILE_SECRET_KEY: "dev does not enforce Turnstile; osn-api is key-optional",
  ZAP_API_URL: "a deletion fan-out target; the dev stack sets none",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("what osn-api reads on dev", () => {
  test("K9: every env name osn-api's source reads is declared, or deliberately unset with a reason", () => {
    const read = new Set(
      sourceFiles(osnApiSource).flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(READ)].map((match) => match[1] ?? match[2] ?? ""),
      ),
    );
    const declared = musubiDeclaration({
      stage: "dev",
      hosts: stageHosts("example.test", "dev"),
      generatedDir: ".generated",
    }).osnApi;
    const secrets = tierSecrets("osn-api", "dev");
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
