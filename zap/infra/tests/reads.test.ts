import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stageHosts, tierSecrets } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { zapDeclaration } from "../src/declaration";

const zapApiSource = fileURLToPath(new URL("../../api/src", import.meta.url));

/** `env.NAME`, `env?.NAME` and `env["NAME"]`, `process.env` included. */
const READ = /\benv\??\.([A-Z][A-Z0-9_]*)\b|\benv\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;

/** The reason for a name that zap-api's production config leaves unset as well. */
const UNSET_ON_PRODUCTION_TOO = "unset on production too";

/**
 * Names zap-api's source reads that the dev stack deliberately leaves unset,
 * each with why. A name given `UNSET_ON_PRODUCTION_TOO` is held to it: the
 * test fails if production's Wrangler vars, bindings or inventory secrets
 * declare it.
 */
const UNSET_ON_DEV: Readonly<Record<string, string>> = {
  NODE_ENV: UNSET_ON_PRODUCTION_TOO,
  PORT: "read only by src/local.ts, the Bun dev server",
  ZAP_API_ARC_KEY_ID: UNSET_ON_PRODUCTION_TOO,
  ZAP_API_ARC_PRIVATE_KEY: UNSET_ON_PRODUCTION_TOO,
  ZAP_ENV: "OSN_ENV marks the tier instead; zap-api reads ZAP_ENV first and OSN_ENV after it",
};

interface WranglerConfig {
  readonly env: {
    readonly production: {
      readonly vars: Readonly<Record<string, string>>;
      readonly d1_databases: readonly { readonly binding: string }[];
    };
  };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("what zap-api reads on dev", () => {
  test("K9: every env name zap-api's source reads is declared, or deliberately unset with a reason", () => {
    const read = new Set(
      sourceFiles(zapApiSource).flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(READ)].map((match) => match[1] ?? match[2] ?? ""),
      ),
    );
    const declared = zapDeclaration({
      stage: "dev",
      hosts: stageHosts("example.test", "dev"),
      generatedDir: ".generated",
    }).zapApi;
    const secrets = tierSecrets("zap-api", "dev");
    const onDev = new Set([
      ...Object.keys(declared.vars),
      ...Object.keys(declared.bindings),
      ...secrets.secrets,
      ...secrets.optional,
    ]);

    expect([...read].filter((name) => !onDev.has(name)).toSorted()).toEqual(
      Object.keys(UNSET_ON_DEV).toSorted(),
    );

    const production = (
      Bun.TOML.parse(
        readFileSync(fileURLToPath(new URL("../../api/wrangler.toml", import.meta.url)), "utf8"),
      ) as WranglerConfig
    ).env.production;
    const productionSecrets = tierSecrets("zap-api", "production");
    const onProduction = new Set([
      ...Object.keys(production.vars),
      ...production.d1_databases.map((database) => database.binding),
      ...productionSecrets.secrets,
      ...productionSecrets.optional,
    ]);
    const claimedUnsetOnProduction = Object.entries(UNSET_ON_DEV)
      .filter(([, reason]) => reason === UNSET_ON_PRODUCTION_TOO)
      .map(([name]) => name);
    expect(claimedUnsetOnProduction.filter((name) => onProduction.has(name))).toEqual([]);
  });
});
