#!/usr/bin/env bun
/**
 * Guard: every third-party skill under `.agents/skills/` is the tree
 * `skills-lock.json` says was installed, taken from a pinned upstream commit.
 *
 * `npx skills add` writes one lock entry per skill: `ref` is the upstream
 * commit when the source was given as `<owner>/<repo>#<sha>`, and
 * `computedHash` is a SHA-256 over the installed folder. The CLI never
 * checks that hash again — `npx skills update` re-installs without comparing
 * it — so without this script nothing notices a file edited in place, a
 * folder copied in by hand, or an entry installed from a branch.
 *
 * Findings, one per skill:
 * - `ref` is not a full 40-character commit SHA (a branch or tag moves);
 * - the lock names a skill with no folder under `.agents/skills/`;
 * - the folder's hash is not the lock's `computedHash`;
 * - a folder under `.agents/skills/` has no lock entry.
 *
 * The hash is the `skills` CLI's own algorithm, so a CLI version that
 * changes it fails this check on the install that bumps the version.
 *
 * Tests in scripts/tests/check-skills-lock.test.ts, which also run this
 * against the real tree on every pull request.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const LOCK = "skills-lock.json";
const SKILLS_DIR = ".agents/skills";
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export type Finding = {
  readonly skill: string;
  readonly problem: string;
};

type LockEntry = {
  readonly ref?: unknown;
  readonly computedHash?: unknown;
};

type SkillFile = { readonly relativePath: string; readonly content: Buffer };

async function collectFiles(base: string, dir: string): Promise<readonly SkillFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<readonly SkillFile[]> => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") return [];
        return collectFiles(base, full);
      }
      if (!entry.isFile()) return [];
      return [
        { relativePath: relative(base, full).split("\\").join("/"), content: await readFile(full) },
      ];
    }),
  );
  return nested.flat();
}

/**
 * The `skills` CLI's folder hash: every regular file below `dir` except
 * under `.git` and `node_modules`, sorted by relative path with
 * `localeCompare` (locale order, not byte order), each fed to SHA-256 as its
 * path then its bytes.
 */
export async function hashSkillFolder(dir: string): Promise<string> {
  const files = [...(await collectFiles(dir, dir))];
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

async function installedSkills(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(root, SKILLS_DIR), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

type Lock =
  | { readonly entries: Readonly<Record<string, LockEntry>> }
  | { readonly unreadable: Finding };

async function readLock(root: string): Promise<Lock> {
  let text: string;
  try {
    text = await readFile(join(root, LOCK), "utf8");
  } catch {
    return { entries: {} };
  }
  let parsed: { skills?: unknown };
  try {
    parsed = JSON.parse(text) as { skills?: unknown };
  } catch {
    return { unreadable: { skill: LOCK, problem: "is not valid JSON" } };
  }
  if (typeof parsed.skills !== "object" || parsed.skills === null) {
    return { unreadable: { skill: LOCK, problem: "has no `skills` object" } };
  }
  return { entries: parsed.skills as Record<string, LockEntry> };
}

export async function checkSkillsLock(root: string): Promise<readonly Finding[]> {
  const lock = await readLock(root);
  if ("unreadable" in lock) return [lock.unreadable];
  const { entries } = lock;
  const installed = new Set(await installedSkills(root));

  const perEntry = await Promise.all(
    Object.entries(entries).map(async ([skill, entry]): Promise<readonly Finding[]> => {
      const found: Finding[] = [];
      if (typeof entry.ref !== "string" || !COMMIT_SHA.test(entry.ref)) {
        found.push({
          skill,
          problem: `ref ${JSON.stringify(entry.ref ?? null)} is not a 40-character commit SHA`,
        });
      }
      if (!installed.has(skill)) {
        found.push({ skill, problem: `is in ${LOCK} but ${SKILLS_DIR}/${skill}/ does not exist` });
        return found;
      }
      const actual = await hashSkillFolder(join(root, SKILLS_DIR, skill));
      if (actual !== entry.computedHash) {
        found.push({
          skill,
          problem: `folder hash ${actual} is not the computedHash in ${LOCK} — a file changed after install`,
        });
      }
      return found;
    }),
  );
  const findings: Finding[] = perEntry.flat();

  for (const skill of installed) {
    if (!Object.hasOwn(entries, skill)) {
      findings.push({ skill, problem: `is in ${SKILLS_DIR}/ with no entry in ${LOCK}` });
    }
  }

  return findings;
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url).pathname;
  const findings = await checkSkillsLock(root);

  if (findings.length > 0) {
    process.stderr.write(
      [
        "❌ check-skills-lock: third-party skills do not match skills-lock.json.",
        ...findings.map(({ skill, problem }) => `   ${skill} — ${problem}`),
        "",
        "   Install or move a pin only with the recipe in wiki/conventions/agent-tooling.md",
        "   §Third-party skills, never by editing the tree or the lock. A fix to the skill's",
        "   text goes upstream and comes back as a new pin.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  process.stdout.write(
    "✅ check-skills-lock: every third-party skill matches its pinned lock entry.\n",
  );
}
