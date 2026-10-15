import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type PackageJson = {
  readonly version?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
};

const readPackage = (path: string): PackageJson =>
  JSON.parse(readFileSync(path, "utf8")) as PackageJson;

const own = readPackage(new URL("../package.json", import.meta.url).pathname);
const scripts = own.scripts ?? {};
const alchemyCommands = ["plan", "deploy", "drift", "destroy"] as const;

describe("package scripts", () => {
  test("every Alchemy command runs at stage dev with telemetry off", () => {
    for (const name of alchemyCommands) {
      const script = scripts[name] ?? "";
      expect(script).toContain("bun alchemy ");
      expect(script).toContain("--stage dev");
      expect(script).toStartWith("DO_NOT_TRACK=1 ");
    }
  });

  test("only destroy asks for teardown mode", () => {
    expect(scripts.destroy).toContain("ALCHEMY_PROBE_TEARDOWN=1");
    for (const name of ["plan", "deploy", "drift"] as const) {
      expect(scripts[name]).not.toContain("ALCHEMY_PROBE_TEARDOWN");
    }
  });
});

// The storage preflight checks every setting Alchemy 2.0.0-beta.80's adoption
// update writes. Another version can write more, so moving the pin fails here
// until `storage-preflight.ts` has been re-checked against the new
// `src/Cloudflare/R2/Bucket.ts` (`read`, `reconcile`) and
// `src/Cloudflare/D1/Database.ts` (`reconcile`), and this test updated.
const AUDITED_ALCHEMY = "2.0.0-beta.80";

describe("pinned Alchemy", () => {
  test("the declared and installed Alchemy are the audited version", () => {
    expect(own.dependencies?.alchemy).toBe(AUDITED_ALCHEMY);
    const installed = readPackage(
      join(dirname(Bun.resolveSync("alchemy", import.meta.dir)), "..", "package.json"),
    );
    expect(installed.version).toBe(AUDITED_ALCHEMY);
  });

  test("the distilled client is the one Alchemy itself pins", () => {
    const alchemyPackage = readPackage(
      join(dirname(Bun.resolveSync("alchemy", import.meta.dir)), "..", "package.json"),
    );
    expect(own.dependencies?.["@distilled.cloud/cloudflare"]).toBe(
      alchemyPackage.dependencies?.["@distilled.cloud/cloudflare"],
    );
  });
});
