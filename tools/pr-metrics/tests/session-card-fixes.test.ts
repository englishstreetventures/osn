import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bodyIssueLinks,
  defaultSessionsRoots,
  humanTurnText,
  parseNumstat,
  renamedTo,
  unattributedSubagentFiles,
  type SessionRecord,
} from "../index.ts";

describe("renamedTo", () => {
  test("takes the new side of a braced directory rename", () => {
    expect(renamedTo("osn/{ui => auth-ui}/src/index.ts")).toBe("osn/auth-ui/src/index.ts");
  });

  test("drops an empty side without leaving a double slash", () => {
    expect(renamedTo("osn/{ => extra}/index.ts")).toBe("osn/extra/index.ts");
    expect(renamedTo("osn/{old => }/index.ts")).toBe("osn/index.ts");
  });

  test("takes the new side of a top-level rename", () => {
    expect(renamedTo("old.ts => new.ts")).toBe("new.ts");
  });

  test("leaves a plain path alone", () => {
    expect(renamedTo("zap/api/src/index.ts")).toBe("zap/api/src/index.ts");
  });
});

describe("parseNumstat packages", () => {
  test("names the package a directory rename moved into, not a brace fragment", () => {
    const diff = parseNumstat("3\t1\tosn/{ui => auth-ui}/src/index.ts\n", 1);

    expect(diff.packages).toEqual(["osn/auth-ui"]);
  });

  test("does not count a file sitting directly in a workspace directory", () => {
    const diff = parseNumstat("1\t0\tzap/README.md\n2\t2\tzap/api/src/index.ts\n", 1);

    expect(diff.packages).toEqual(["zap/api"]);
  });

  test("counts the musubi workspace", () => {
    const diff = parseNumstat("5\t0\tmusubi/social/src/app.tsx\n", 1);

    expect(diff.packages).toEqual(["musubi/social"]);
  });
});

describe("bodyIssueLinks", () => {
  test("separates closing links from Part of links, without repeats", () => {
    expect(bodyIssueLinks("Closes #12\nPart of #7\nFixes #12")).toEqual({
      closes: [12],
      partOf: [7],
      foreignCloses: [],
      foreignPartOf: [],
    });
  });

  test("leaves out another repository's issue", () => {
    expect(bodyIssueLinks("Closes englishstreetventures/osn-tracker#593")).toEqual({
      closes: [],
      partOf: [],
      foreignCloses: [593],
      foreignPartOf: [],
    });
  });

  test("ignores a number that is not a closing reference", () => {
    expect(bodyIssueLinks("See #40 for the history.")).toEqual({
      closes: [],
      partOf: [],
      foreignCloses: [],
      foreignPartOf: [],
    });
  });

  test("reads a colon after the keyword", () => {
    expect(bodyIssueLinks("Closes: #9")).toEqual({
      closes: [9],
      partOf: [],
      foreignCloses: [],
      foreignPartOf: [],
    });
  });

  test("a run of spaces after a keyword resolves quickly", () => {
    const started = performance.now();
    bodyIssueLinks(`Closes${" ".repeat(20_000)}x`);

    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("humanTurnText", () => {
  const userRecord = (content: string): SessionRecord => ({
    type: "user",
    sessionId: "s",
    message: { content },
  });

  test("drops a subagent hand-back that opens with prose", () => {
    const record = userRecord(
      'Another Claude session sent a message: <agent-message from="reviewer">done</agent-message>',
    );

    expect(humanTurnText(record)).toBeNull();
  });

  test("drops a task notification that opens with prose", () => {
    const record = userRecord(
      "Another Claude session sent a message: <task-notification>x</task-notification>",
    );

    expect(humanTurnText(record)).toBeNull();
  });

  test("keeps a person who quotes the tag mid-sentence", () => {
    const record = userRecord(
      "The <agent-message> tag is what the reviewer prints, so fix the parser",
    );

    expect(humanTurnText(record)).toBe(
      "The <agent-message> tag is what the reviewer prints, so fix the parser",
    );
  });
});

describe("defaultSessionsRoots", () => {
  test("reads the home directory alone when no config directory is set", () => {
    expect(defaultSessionsRoots({ HOME: "/home/a" })).toEqual(["/home/a/.claude/projects"]);
  });

  test("reads the config directory and the home directory when both are set", () => {
    expect(
      defaultSessionsRoots({ HOME: "/home/a", CLAUDE_CONFIG_DIR: "/home/a/.claude-x/" }),
    ).toEqual(["/home/a/.claude-x/projects", "/home/a/.claude/projects"]);
  });

  test("does not read the same directory twice", () => {
    expect(defaultSessionsRoots({ HOME: "/home/a", CLAUDE_CONFIG_DIR: "/home/a/.claude" })).toEqual(
      ["/home/a/.claude/projects"],
    );
  });
});

describe("unattributedSubagentFiles", () => {
  test("counts a workflow agent's transcript as subagent spend", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-metrics-workflow-"));

    try {
      const agents = join(root, "-proj", "session-1", "subagents", "workflows", "wf_1");
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, "agent-x.jsonl"), '{"type":"user","gitBranch":"main"}\n');

      expect(unattributedSubagentFiles(root)).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads every root it is given, and ignores a root that does not exist", async () => {
    const first = await mkdtemp(join(tmpdir(), "pr-metrics-root-a-"));
    const second = await mkdtemp(join(tmpdir(), "pr-metrics-root-b-"));

    try {
      for (const root of [first, second]) {
        const agents = join(root, "-proj", "session-1", "subagents");
        await mkdir(agents, { recursive: true });
        await writeFile(join(agents, "agent-x.jsonl"), '{"type":"user","gitBranch":"main"}\n');
      }

      expect(unattributedSubagentFiles([first, second, join(first, "absent")])).toBe(2);
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  test("a root path with a space is still read", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pr-metrics-space-"));
    const root = join(parent, "config dir", "projects");

    try {
      const agents = join(root, "-proj", "session-1", "subagents");
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, "agent-x.jsonl"), '{"type":"user","gitBranch":"main"}\n');

      expect(unattributedSubagentFiles(root)).toBe(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
