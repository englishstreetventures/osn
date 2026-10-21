import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bodyIssueLinks,
  chooseLinkedIssue,
  defaultSessionsRoots,
  humanTurnText,
  isBareContinuation,
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
  test("reads closing and Part of keywords, in body order", () => {
    expect(bodyIssueLinks("Closes #12\nPart of #7\nFixes #12")).toEqual([12, 7]);
  });

  test("leaves out another repository's issue", () => {
    expect(bodyIssueLinks("Closes englishstreetventures/osn-tracker#593")).toEqual([]);
  });

  test("ignores a number that is not a closing reference", () => {
    expect(bodyIssueLinks("See #40 for the history.")).toEqual([]);
  });
});

describe("chooseLinkedIssue", () => {
  test("records nothing when no issue is linked", () => {
    expect(chooseLinkedIssue([])).toEqual({ issue: null, candidates: [] });
  });

  test("takes the one linked issue", () => {
    expect(chooseLinkedIssue([5, 5])).toEqual({ issue: 5, candidates: [5] });
  });

  test("refuses to choose between several, and names them", () => {
    expect(chooseLinkedIssue([1031, 1550, 1033])).toEqual({
      issue: null,
      candidates: [1031, 1550, 1033],
    });
  });
});

describe("isBareContinuation", () => {
  test("matches a nudge to keep going", () => {
    expect(isBareContinuation("continue")).toBe(true);
    expect(isBareContinuation("Continue.")).toBe(true);
    expect(isBareContinuation("  go on  ")).toBe(true);
  });

  test("does not match a correction that starts the same way", () => {
    expect(isBareContinuation("continue, but use the other index")).toBe(false);
    expect(isBareContinuation("Prep pr")).toBe(false);
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
});
