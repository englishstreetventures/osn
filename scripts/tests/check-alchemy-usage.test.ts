import { describe, expect, test } from "bun:test";

import {
  checkCompositeAction,
  checkPackageScripts,
  checkStackSource,
  checkWorkflow,
} from "../check-alchemy-usage";

const manifest = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

describe("checkPackageScripts", () => {
  test.each([
    "DO_NOT_TRACK=1 bun alchemy state ls --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy provider cloudflare bootstrap --worker-name alchemy-state-store",
  ])("passes %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([]);
  });

  test.each([
    "bun alchemy deploy --stage dev",
    "bunx alchemy@2.0.0-beta.83 deploy",
    "./node_modules/.bin/alchemy deploy",
    "alchemy --stage dev deploy",
    "alchemy ./alchemy.run.ts --stage dev",
  ])("flags %j, which runs Alchemy with telemetry on", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });

  test("ignores scripts that do not run Alchemy", () => {
    expect(
      checkPackageScripts(
        "p",
        manifest({
          test: "bunx --bun vitest",
          name: "echo alchemy-state",
          file: "cat alchemy.run.ts",
        }),
      ),
    ).toEqual([]);
  });

  test.each([
    "DO_NOT_TRACK=1 bun alchemy state",
    "DO_NOT_TRACK=1 bun alchemy state read cire/dev",
    "DO_NOT_TRACK=1 bun alchemy state cat cire",
    "DO_NOT_TRACK=1 bun alchemy provider cloudflare state logs",
    "DO_NOT_TRACK=1 bun alchemy drift --stage dev --repair",
    "DO_NOT_TRACK=1 bun alchemy unsafe nuke",
    "DO_NOT_TRACK=1 bun alchemy provider cloudflare teardown --yes",
  ])("refuses %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });
});

describe("checkCompositeAction", () => {
  const action = (stepEnv: string, run: string) => `
name: a
runs:
  using: composite
  steps:
    - shell: bash
${stepEnv}
      run: ${run}
`;

  test("needs DO_NOT_TRACK on the step or the line", () => {
    expect(
      checkCompositeAction(
        "a",
        action('      env:\n        DO_NOT_TRACK: "1"', "bunx alchemy deploy"),
      ),
    ).toEqual([]);
    expect(checkCompositeAction("a", action("", "DO_NOT_TRACK=1 bunx alchemy deploy"))).toEqual([]);
    expect(checkCompositeAction("a", action("", "bunx alchemy deploy"))).toHaveLength(1);
  });
});

describe("checkWorkflow", () => {
  const workflow = (env: string, stepEnv: string, run: string) => `
name: t
on: workflow_dispatch
${env}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: s
${stepEnv}
        run: ${run}
`;

  test("accepts DO_NOT_TRACK at workflow, step or inline level", () => {
    expect(
      checkWorkflow(
        "w",
        workflow('env:\n  DO_NOT_TRACK: "1"', "", "bunx alchemy deploy --stage dev"),
      ),
    ).toEqual([]);
    expect(
      checkWorkflow(
        "w",
        workflow("", '        env:\n          DO_NOT_TRACK: "1"', "bunx alchemy deploy"),
      ),
    ).toEqual([]);
    expect(checkWorkflow("w", workflow("", "", "DO_NOT_TRACK=1 bunx alchemy deploy"))).toEqual([]);
  });

  test("flags an Alchemy run with telemetry on", () => {
    expect(checkWorkflow("w", workflow("", "", "bunx alchemy deploy --stage dev"))).toHaveLength(1);
  });

  test("refuses a run that prints state", () => {
    expect(
      checkWorkflow("w", workflow('env:\n  DO_NOT_TRACK: "1"', "", "bunx alchemy state read cire")),
    ).toHaveLength(1);
  });
});

describe("checkStackSource", () => {
  test.each([
    "const s = Alchemy.localState();",
    "const s = inMemoryState();",
    "const s = Cloudflare.state();",
    "const s = Cloudflare.state;",
    "const s = postgresState({ url });",
    'import { state } from "alchemy/Cloudflare";',
  ])("refuses %j in a stack file", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  test("passes a stack that takes stackOptions()", () => {
    expect(
      checkStackSource("cire/infra/alchemy.run.ts", "Alchemy.Stack('cire', stackOptions(), body)"),
    ).toEqual([]);
  });
});
