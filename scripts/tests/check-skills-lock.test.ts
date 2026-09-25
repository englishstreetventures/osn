import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkSkillsLock, hashSkillFolder } from "../check-skills-lock";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const REAL_SCRIPT = new URL("../check-skills-lock.ts", import.meta.url).pathname;
const SHA = "af2319bd01bb7cc881267a9ef42cafdaf5e9029d";

let root = "";

async function writeSkill(name: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, ".agents/skills", name, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
}

type Entry = { ref?: string; computedHash?: string };

async function writeLock(skills: Record<string, Entry>) {
  const entries = Object.fromEntries(
    Object.entries(skills).map(([name, entry]) => [
      name,
      {
        source: "owner/repo",
        sourceType: "github",
        skillPath: `skills/${name}/SKILL.md`,
        ...entry,
      },
    ]),
  );
  await writeFile(join(root, "skills-lock.json"), JSON.stringify({ version: 1, skills: entries }));
}

async function installClean(name = "demo") {
  await writeSkill(name, { "SKILL.md": "---\nname: demo\n---\n", "docs/a.md": "alpha\n" });
  return { ref: SHA, computedHash: await hashSkillFolder(join(root, ".agents/skills", name)) };
}

describe("hashSkillFolder", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-lock-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("hashes each file's relative path then its bytes, sorted by path", async () => {
    await writeSkill("demo", { "b.md": "bee", "a/c.md": "sea", "SKILL.md": "skill" });
    // Written out by hand so the vector does not come from the function under
    // test. The order is locale order, as the CLI sorts: byte order would put
    // `SKILL.md` first.
    const expected = createHash("sha256");
    for (const [path, body] of [
      ["a/c.md", "sea"],
      ["b.md", "bee"],
      ["SKILL.md", "skill"],
    ] as const) {
      expected.update(path);
      expected.update(body);
    }
    expect(await hashSkillFolder(join(root, ".agents/skills/demo"))).toBe(expected.digest("hex"));
  });

  test("skips .git and node_modules, as the skills CLI does", async () => {
    await writeSkill("demo", { "SKILL.md": "skill" });
    const before = await hashSkillFolder(join(root, ".agents/skills/demo"));
    await writeSkill("demo", { ".git/HEAD": "ref", "node_modules/x/index.js": "x" });
    expect(await hashSkillFolder(join(root, ".agents/skills/demo"))).toBe(before);
  });
});

describe("checkSkillsLock", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-lock-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a tree installed from a pinned commit and left alone passes", async () => {
    await writeLock({ demo: await installClean() });
    expect(await checkSkillsLock(root)).toEqual([]);
  });

  test("no lock and no .agents/skills is nothing to check", async () => {
    expect(await checkSkillsLock(root)).toEqual([]);
  });

  test("an entry with no ref is unpinned", async () => {
    const { computedHash } = await installClean();
    await writeLock({ demo: { computedHash } });
    const findings = await checkSkillsLock(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ skill: "demo" });
    expect(findings[0]!.problem).toContain("commit");
  });

  test("a branch name is not a pin", async () => {
    const { computedHash } = await installClean();
    await writeLock({ demo: { ref: "main", computedHash } });
    expect(await checkSkillsLock(root)).toHaveLength(1);
  });

  test("a short SHA is not a pin", async () => {
    const { computedHash } = await installClean();
    await writeLock({ demo: { ref: SHA.slice(0, 7), computedHash } });
    expect(await checkSkillsLock(root)).toHaveLength(1);
  });

  test("a file edited after install no longer matches the lock", async () => {
    await writeLock({ demo: await installClean() });
    await writeSkill("demo", { "docs/a.md": "alpha, fixed in place\n" });
    const findings = await checkSkillsLock(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toContain("hash");
  });

  test("a file added after install no longer matches the lock", async () => {
    await writeLock({ demo: await installClean() });
    await writeSkill("demo", { "docs/extra.md": "new\n" });
    expect(await checkSkillsLock(root)).toHaveLength(1);
  });

  test("a folder with no lock entry was copied in, not installed", async () => {
    await writeLock({ demo: await installClean() });
    await writeSkill("stray", { "SKILL.md": "---\nname: stray\n---\n" });
    const findings = await checkSkillsLock(root);
    expect(findings).toEqual([expect.objectContaining({ skill: "stray" })]);
  });

  test("a folder with no lock at all is flagged", async () => {
    await installClean();
    expect(await checkSkillsLock(root)).toEqual([expect.objectContaining({ skill: "demo" })]);
  });

  test("an entry whose folder is gone is flagged", async () => {
    const entry = await installClean();
    await writeLock({ demo: entry, gone: { ref: SHA, computedHash: entry.computedHash } });
    expect(await checkSkillsLock(root)).toEqual([expect.objectContaining({ skill: "gone" })]);
  });

  test("a lock that is not JSON is flagged, not skipped", async () => {
    await installClean();
    await writeFile(join(root, "skills-lock.json"), "{ not json");
    const findings = await checkSkillsLock(root);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.skill).toBe("skills-lock.json");
  });

  test("a lock with no skills object is flagged, not read as empty", async () => {
    await installClean();
    await writeFile(join(root, "skills-lock.json"), JSON.stringify({ version: 1 }));
    expect(await checkSkillsLock(root)).toEqual([
      { skill: "skills-lock.json", problem: "has no `skills` object" },
    ]);
  });
});

// The cases above prove the check works; this one proves the tree the
// repository ships still passes it. It is the gate: `bun run test:scripts`
// runs on every pull request.
test("this repository's skills-lock.json pins every installed skill and matches its tree", async () => {
  expect(await checkSkillsLock(REPO_ROOT)).toEqual([]);
});

describe("the script run as a command", () => {
  async function run(cwdRoot: string, script: string) {
    const proc = Bun.spawn(["bun", "run", script], {
      cwd: cwdRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("exits 0 against this repository", async () => {
    const out = await run(REPO_ROOT, REAL_SCRIPT);
    expect(out.stderr).toBe("");
    expect(out.exitCode).toBe(0);
  });

  test("exits 1 and names the skill when a copy of it guards a broken tree", async () => {
    root = await mkdtemp(join(tmpdir(), "skills-lock-cli-"));
    try {
      const { computedHash } = await installClean();
      await writeLock({ demo: { ref: "main", computedHash } });
      // The script resolves its root as `../` from its own file, so a copy at
      // `<tmp>/scripts/` checks `<tmp>` and never the real repository.
      await mkdir(join(root, "scripts"));
      const copy = join(root, "scripts/check-skills-lock.ts");
      await cp(REAL_SCRIPT, copy);
      const out = await run(root, copy);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain("demo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
