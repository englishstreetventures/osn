import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

const HOST = /\b[a-z0-9-]+\.(?:com|social|events|dev|app)\b/g;

/** The one literal that names a domain without naming a host, allowed on a line commented as such. */
const ALLOWED = "cireweddings.com";

/** Every `.ts` file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Each host-like literal outside comments, as `file:line: match`. A
 * `cireweddings.com` is allowed only on a line whose trailing comment says
 * it is not a host.
 */
function literalHosts(file: string, text: string): string[] {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  return withoutBlocks.split("\n").flatMap((line, index) => {
    const comment = /(?:^|\s)\/\/(.*)$/.exec(line);
    const code = comment === null ? line : line.slice(0, comment.index);
    const notAHost = comment !== null && /not a host/i.test(comment[1] ?? "");
    return [...code.matchAll(HOST)]
      .map((match) => match[0])
      .filter((host) => !(host === ALLOWED && notAHost))
      .map((host) => `${file}:${index + 1}: ${host}`);
  });
}

describe("cire stack source", () => {
  test("K7: holds no literal host; every host derives from DEV_DOMAIN", () => {
    // The scan finds what it is meant to find.
    expect(literalHosts("sample.ts", 'const issuer = "id.musubi.social";')).toEqual([
      "sample.ts:1: musubi.social",
    ]);
    expect(literalHosts("sample.ts", 'const from = "dev@cireweddings.com";')).toEqual([
      "sample.ts:1: cireweddings.com",
    ]);
    expect(
      literalHosts("sample.ts", 'const from = "dev@cireweddings.com"; // not a host: a sender'),
    ).toEqual([]);

    const files = [join(packageDir, "alchemy.run.ts"), ...sources(join(packageDir, "src"))];
    const found = files.flatMap((path) =>
      literalHosts(relative(packageDir, path), readFileSync(path, "utf8")),
    );
    expect(found).toEqual([]);
  });
});
