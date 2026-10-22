#!/usr/bin/env bun
/**
 * Lists every wikilink in the wiki that resolves to no page, and exits 1 when
 * there is one. Run it from the repository root: `bun scripts/check-wikilinks.ts`.
 *
 * It checks the whole vault, not a branch's diff, because the usual break is a
 * page renamed or deleted on the branch while the links into it sit in pages
 * the branch never touched.
 *
 * A page is a file `git ls-files` reports under `wiki/`, tracked or new, minus
 * what `.gitignore` excludes: a link to a private, ignored page resolves on one
 * machine and is broken for everyone else.
 *
 * A target resolves the way Obsidian's own resolver does it, with the vault
 * root at `wiki/`: case-insensitively, the basename exactly (`.md` implied),
 * and any folder part as the tail of the page's folder. Obsidian matches that
 * tail as a plain string suffix; this matches it only at a `/`, so a typo like
 * `[[ared/component-library]]` is reported too. A target written from the
 * repository root, `[[wiki/shared/component-library]]`, names `wiki/wiki/…`
 * and resolves to nothing.
 *
 * Text inside fenced code blocks and inline code spans is not read: a TOML
 * array header such as `[[env.production.d1_databases]]` has a wikilink's
 * shape, and Obsidian renders neither as a link. Relative `./` and `../`
 * targets are not resolved and are reported.
 *
 * Exit codes: 0 every link resolves, 1 at least one does not, 2 the check
 * could not run (no `wiki/` folder under the working directory, or git failed).
 */

import { existsSync, readFileSync, statSync } from "node:fs";

export type Page = {
  readonly path: string;
  readonly text: string;
};

export type BrokenLink = {
  readonly path: string;
  readonly line: number;
  readonly target: string;
};

const WIKILINK = /\[\[([^\]\n]*)\]\]/g;
const CODE_SPAN = /(`+).*?\1/g;
const FENCE = /^\s*(`{3,}|~{3,})/;

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The target part of a link's inner text: no heading, block, alias or table escape. */
function targetOf(inner: string): string {
  const cut = inner.search(/[#|]/);
  const head = cut === -1 ? inner : inner.slice(0, cut);
  return head.replace(/\\$/, "").trim();
}

/** Lower-cased basename to the lower-cased folders that hold a file of that name. */
function indexVault(vaultFiles: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of vaultFiles) {
    const lower = file.toLowerCase();
    const folders = index.get(basename(lower)) ?? [];
    folders.push(folderOf(lower));
    index.set(basename(lower), folders);
  }
  return index;
}

function resolves(target: string, index: Map<string, string[]>): boolean {
  const lower = target.toLowerCase();
  const name = basename(lower);
  const folders = [...(index.get(name) ?? []), ...(index.get(`${name}.md`) ?? [])];
  if (folders.length === 0) return false;

  const wanted = folderOf(lower);
  if (wanted === "") return true;
  return folders.some((folder) => folder === wanted || folder.endsWith(`/${wanted}`));
}

/** Every link in `pages` whose target names no file in `vaultFiles` (paths relative to the vault root). */
export function findBrokenWikilinks(
  vaultFiles: readonly string[],
  pages: readonly Page[],
): BrokenLink[] {
  const index = indexVault(vaultFiles);
  const broken: BrokenLink[] = [];

  for (const page of pages) {
    let fence: { readonly char: string; readonly length: number } | null = null;

    for (const [i, line] of page.text.split("\n").entries()) {
      const marker = FENCE.exec(line)?.[1];
      if (fence !== null) {
        const closes =
          marker !== undefined &&
          marker[0] === fence.char &&
          marker.length >= fence.length &&
          line.trim() === marker;
        if (closes) fence = null;
        continue;
      }
      if (marker !== undefined) {
        fence = { char: marker[0] ?? "`", length: marker.length };
        continue;
      }

      for (const match of line.replace(CODE_SPAN, "").matchAll(WIKILINK)) {
        const target = targetOf(match[1] ?? "");
        if (target !== "" && !resolves(target, index)) {
          broken.push({ path: page.path, line: i + 1, target });
        }
      }
    }
  }

  return broken;
}

function fail(message: string): never {
  process.stderr.write(`check-wikilinks: ${message}\n`);
  process.exit(2);
}

if (import.meta.main) {
  if (!existsSync("wiki") || !statSync("wiki").isDirectory()) {
    fail("no wiki/ folder here; run it from the repository root.");
  }

  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "wiki"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) fail(`git ls-files failed: ${listed.stderr.toString().trim()}`);

  // A tracked file deleted from the working tree is still listed by `--cached`.
  const files = [...new Set(listed.stdout.toString().split("\0"))].filter(
    (file) => file !== "" && existsSync(file),
  );
  const vaultFiles = files.map((file) => file.slice("wiki/".length));
  const pages = files
    .filter((file) => file.endsWith(".md"))
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));

  const broken = findBrokenWikilinks(vaultFiles, pages);
  for (const link of broken) {
    const hint = link.target.toLowerCase().startsWith("wiki/")
      ? " — the vault root is wiki/; drop the wiki/ prefix"
      : "";
    process.stdout.write(`${link.path}:${link.line}: [[${link.target}]]${hint}\n`);
  }

  if (broken.length > 0) {
    process.stderr.write(
      `check-wikilinks: ${broken.length} wikilink(s) in ${pages.length} pages resolve to no page.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`check-wikilinks: every wikilink in ${pages.length} pages resolves.\n`);
}
