import { describe, expect, test } from "bun:test";

import { runMode } from "../run-mode.ts";

const stackDir = "/repo/tools/alchemy";
const base = { stage: "dev", cwd: stackDir, stackDir, teardown: false };

describe("runMode", () => {
  test("a dev run from the stack directory deploys", () => {
    expect(runMode(base)).toEqual({ kind: "deploy" });
  });

  test("any stage but dev is refused, teardown included", () => {
    for (const stage of ["production", "staging", "prod", ""]) {
      expect(runMode({ ...base, stage }).kind).toBe("refuse");
      expect(runMode({ ...base, stage, teardown: true }).kind).toBe("refuse");
    }
  });

  test("a run from another directory is refused, so state is always the stack directory's", () => {
    const fromRoot = runMode({ ...base, cwd: "/repo" });
    expect(fromRoot.kind).toBe("refuse");
    expect(fromRoot.kind === "refuse" && fromRoot.reason).toContain("tools/alchemy");
    expect(runMode({ ...base, cwd: "/repo", teardown: true }).kind).toBe("refuse");
  });

  test("teardown skips every other check, so cleanup cannot be blocked by them", () => {
    expect(runMode({ ...base, teardown: true })).toEqual({ kind: "teardown" });
  });
});
