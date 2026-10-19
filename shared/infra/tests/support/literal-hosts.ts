/**
 * The scan behind each stack's K7 test (`<product>/infra/tests/no-literal-hosts.test.ts`
 * imports this by relative path): every host a stack's source names in a
 * string literal, which must be none, since every host derives from
 * DEV_DOMAIN. Its own tests are `shared/infra/tests/literal-hosts.test.ts`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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
export function literalHosts(file: string, text: string): string[] {
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

/**
 * Every literal host in a stack package's source, its `alchemy.run.ts` and
 * each `.ts` file under `src/`, as `file:line: host` with the file relative to
 * the package.
 */
export function stackLiteralHosts(packageDir: string): string[] {
  const files = [join(packageDir, "alchemy.run.ts"), ...sources(join(packageDir, "src"))];
  return files.flatMap((path) =>
    literalHosts(relative(packageDir, path), readFileSync(path, "utf8")),
  );
}
