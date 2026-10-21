import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { literalHosts, stackLiteralHosts } from "./support/literal-hosts";

describe("the literal-host scan each stack's K7 runs", () => {
  test("K7: finds a host in a string literal under any top-level domain, since the real DEV_DOMAIN's is unknown", () => {
    expect(literalHosts("sample.ts", 'const issuer = "id.musubi.social";')).toEqual([
      "sample.ts:1: id.musubi.social",
    ]);
    expect(literalHosts("sample.ts", 'const api = "https://api.cire.dev-zone.net/x";')).toEqual([
      "sample.ts:1: api.cire.dev-zone.net",
    ]);
    expect(literalHosts("sample.ts", "const a = 1;\nconst b = `id.${stage}.zone.test`;")).toEqual([
      "sample.ts:2: id.xxxxxxxx.zone.test",
    ]);
    expect(literalHosts("sample.ts", 'const from = "dev@cireweddings.com";')).toEqual([
      "sample.ts:1: cireweddings.com",
    ]);
    expect(
      literalHosts("sample.ts", 'const from = "dev@cireweddings.com"; // not a host: a sender'),
    ).toEqual([]);
    expect(
      literalHosts(
        "sample.ts",
        'const from = "Musubi <hello@musubi.social>"; // not a host: a sender',
      ),
    ).toEqual([]);
    expect(
      literalHosts("sample.ts", 'const issuer = "id.musubi.social"; // not a host: a sender'),
    ).toEqual(["sample.ts:1: id.musubi.social"]);
  });

  test("K7: files, paths, template holes and comments are not hosts", () => {
    expect(
      literalHosts(
        "sample.ts",
        'const seed = "../db/seed/dev-seed.sql"; const run = "alchemy.run.ts";\n' +
          "const name = `${input.stage}-db`; // see id.musubi.social",
      ),
    ).toEqual([]);
  });

  test("K7: a stack's scan reads its alchemy.run.ts and every .ts file under src/, nested ones included", () => {
    const dir = mkdtempSync(join(tmpdir(), "literal-hosts-"));
    try {
      mkdirSync(join(dir, "src", "nested"), { recursive: true });
      writeFileSync(join(dir, "alchemy.run.ts"), 'const a = "id.musubi.social";\n');
      writeFileSync(join(dir, "src", "declaration.ts"), '\nconst b = "api.cire.dev-zone.net";\n');
      writeFileSync(join(dir, "src", "nested", "seeds.ts"), 'const c = "pulse.events";\n');
      writeFileSync(join(dir, "src", "notes.md"), "pulse.example.test\n");
      expect(stackLiteralHosts(dir).toSorted()).toEqual(
        [
          "alchemy.run.ts:1: id.musubi.social",
          `${join("src", "declaration.ts")}:2: api.cire.dev-zone.net`,
          `${join("src", "nested", "seeds.ts")}:1: pulse.events`,
        ].toSorted(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
