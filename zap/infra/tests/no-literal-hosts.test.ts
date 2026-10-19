import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * A host-shaped token: dot-joined labels ending in a letters-only label, not
 * inside a path or a longer name (a URL's `//` is blanked first, so its host
 * shows). Any top-level domain, because the one a pasted DEV_DOMAIN would
 * carry is unknown.
 */
const HOST = /(?<![\w./-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w.-])/g;

/** File names have the same shape; these endings are files, not top-level domains. */
const FILE_EXTENSIONS = new Set(["ts", "js", "mjs", "cjs", "sql", "json", "jsonc", "toml", "md"]);

/** String literals: double, single and template quotes, across lines. */
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** The one literal that names a domain without naming a host, allowed on a line commented as such. */
const ALLOWED = "cireweddings.com";

/** Third-party hosts a stack may name: not ours, so never a dev host. */
const THIRD_PARTY: ReadonlySet<string> = new Set(["cdn.growthbook.io"]);

/** Every `.ts` file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Each host in a string literal outside comments, as `file:line: host`. A
 * template's `${…}` holes read as one label, so `id.${stage}.zone.test`
 * still shows. A `cireweddings.com` is allowed only on a line whose trailing
 * comment says it is not a host.
 */
function literalHosts(file: string, text: string): string[] {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  const lines = withoutBlocks.split("\n").map((line) => {
    const comment = /(?:^|\s)\/\/(.*)$/.exec(line);
    return {
      code: comment === null ? line : line.slice(0, comment.index).padEnd(line.length),
      notAHost: comment !== null && /not a host/i.test(comment[1] ?? ""),
    };
  });
  const code = lines.map((line) => line.code).join("\n");
  return [...code.matchAll(STRING)].flatMap((literal) => {
    const lineOf = (offset: number) =>
      code.slice(0, (literal.index ?? 0) + offset).split("\n").length - 1;
    const body = literal[0]
      .replace(/\$\{[^}]*\}/g, (hole) => "x".padEnd(hole.length, "x"))
      .replaceAll("//", "  ");
    return [...body.matchAll(HOST)]
      .filter((match) => !FILE_EXTENSIONS.has(match[0].slice(match[0].lastIndexOf(".") + 1)))
      .filter((match) => !THIRD_PARTY.has(match[0]))
      .map((match) => ({ host: match[0], line: lineOf(match.index ?? 0) }))
      .filter(({ host, line }) => !(host === ALLOWED && lines[line]?.notAHost))
      .map(({ host, line }) => `${file}:${line + 1}: ${host}`);
  });
}

describe("zap stack source", () => {
  test("K7: holds no literal host; every host derives from DEV_DOMAIN", () => {
    // The scan finds what it is meant to find, under any top-level domain,
    // since the real DEV_DOMAIN's is unknown.
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
    // Files, paths, template holes and comments are not hosts.
    expect(
      literalHosts(
        "sample.ts",
        'const seed = "../db/seed/dev-seed.sql"; const run = "alchemy.run.ts";\n' +
          "const name = `${input.stage}-db`; // see id.musubi.social",
      ),
    ).toEqual([]);

    const files = [join(packageDir, "alchemy.run.ts"), ...sources(join(packageDir, "src"))];
    const found = files.flatMap((path) =>
      literalHosts(relative(packageDir, path), readFileSync(path, "utf8")),
    );
    expect(found).toEqual([]);
  });
});
