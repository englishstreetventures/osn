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
    "const s = Layer.effect(State, makeHttpStateStore({ url, authToken }));",
    "const s = Layer.effect(State, makeLocalState());",
    "const s = makePostgresState(options);",
    "const s = InMemoryService(records);",
    'import { State } from "alchemy/State";',
    'import { makePostgresState } from "alchemy/State/PostgresState";',
    'const S = await import("alchemy/State");',
  ])("refuses %j in a stack file", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  test.each([
    'import * as CF from "alchemy/Cloudflare"; CF.state()',
    'import * as Aws from "alchemy/AWS"; Aws.state()',
  ])("refuses a state call through a namespace import, %j", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  test("passes a stack that takes stackOptions()", () => {
    expect(
      checkStackSource("cire/infra/alchemy.run.ts", "Alchemy.Stack('cire', stackOptions(), body)"),
    ).toEqual([]);
  });
});

const blockWorkflow = (env: string, stepEnv: string, lines: readonly string[]) => `
name: t
on: workflow_dispatch
${env}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: s
${stepEnv}
        run: |
${lines.map((line) => `          ${line}`).join("\n")}
`;

const TRACK_OFF = 'env:\n  DO_NOT_TRACK: "1"';

describe("line continuations", () => {
  test.each([
    "DO_NOT_TRACK=1 bunx alchemy drift \\\n--stage dev \\\n--repair",
    "DO_NOT_TRACK=1 bunx alchemy \\\nstate read cire",
    "DO_NOT_TRACK=1 bunx alchemy \\\nnuke",
  ])("refuses %j as a package script", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });

  test.each([
    { lines: ["bunx alchemy drift \\", "--stage dev \\", "--repair"] },
    { lines: ["bunx alchemy \\", "state read cire"] },
    { lines: ["bunx alchemy \\", "nuke"] },
  ])("refuses $lines in a workflow step with telemetry off", ({ lines }) => {
    expect(checkWorkflow("w", blockWorkflow(TRACK_OFF, "", lines))).toHaveLength(1);
  });
});

describe("compound commands", () => {
  test.each([
    "DO_NOT_TRACK=1 bun alchemy state ls && bun alchemy deploy",
    "DO_NOT_TRACK=1 bun alchemy state ls; bun alchemy deploy",
    "DO_NOT_TRACK=1 bun alchemy state ls || bun alchemy deploy",
    "DO_NOT_TRACK=1 bun alchemy state ls | bun alchemy deploy",
    "DO_NOT_TRACK=1 bun alchemy state ls & bun alchemy deploy",
  ])("flags the second command of %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });

  test("flags a ; compound in a workflow step with no env", () => {
    expect(
      checkWorkflow(
        "w",
        blockWorkflow("", "", ["DO_NOT_TRACK=1 bunx alchemy state ls; bunx alchemy deploy"]),
      ),
    ).toHaveLength(1);
  });

  test("passes when every segment carries the prefix", () => {
    expect(
      checkPackageScripts(
        "p",
        manifest({
          x: "DO_NOT_TRACK=1 bun alchemy state ls && DO_NOT_TRACK=1 bun alchemy deploy --stage dev",
        }),
      ),
    ).toEqual([]);
  });
});

describe("commands that print a token or delete a long-lived stage", () => {
  test("refuses creating a Cloudflare API token, which prints it to the log", () => {
    expect(
      checkPackageScripts(
        "p",
        manifest({ x: "DO_NOT_TRACK=1 bun alchemy provider cloudflare token" }),
      ),
    ).toHaveLength(1);
  });

  test.each([
    "DO_NOT_TRACK=1 bun alchemy destroy --stage production",
    "DO_NOT_TRACK=1 bun alchemy destroy --stage=dev",
    "DO_NOT_TRACK=1 bun alchemy --stage dev destroy --yes",
    "DO_NOT_TRACK=1 ALCHEMY_STAGE=production bun alchemy destroy --yes",
    "ALCHEMY_STAGE=dev DO_NOT_TRACK=1 bun alchemy destroy",
    "DO_NOT_TRACK=1 bun alchemy destroy --env-file .env.production",
    'DO_NOT_TRACK=1 bun alchemy destroy --stage "$STAGE"',
    "DO_NOT_TRACK=1 bun alchemy destroy --stage $STAGE",
    "DO_NOT_TRACK=1 bun alchemy destroy --stage pr-7 --stage production",
    "DO_NOT_TRACK=1 bun alchemy destroy --stage=Production",
  ])("refuses %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });

  test.each([
    'env:\n  ALCHEMY_STAGE: production\n  DO_NOT_TRACK: "1"',
    'env:\n  DO_NOT_TRACK: "1"',
  ])("refuses a workflow destroy that leaves the stage to the environment, %j", (env) => {
    expect(checkWorkflow("w", blockWorkflow(env, "", ["bunx alchemy destroy --yes"]))).toHaveLength(
      1,
    );
  });

  test("refuses a workflow destroy whose stage is an expression", () => {
    expect(
      checkWorkflow(
        "w",
        blockWorkflow(TRACK_OFF, "", ["bunx alchemy destroy --stage ${{ inputs.stage }} --yes"]),
      ),
    ).toHaveLength(1);
  });

  test.each([
    "DO_NOT_TRACK=1 bun alchemy destroy --stage pr-7",
    "DO_NOT_TRACK=1 bun alchemy destroy --stage='pr-7' --yes",
    "DO_NOT_TRACK=1 ALCHEMY_STAGE=production bun alchemy destroy --stage pr-7",
  ])("passes destroying an investigation stage, %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([]);
  });

  test.each([
    "DO_NOT_TRACK=1 bun alchemy logs --stage production",
    "DO_NOT_TRACK=1 bun alchemy logs --tail",
  ])("refuses %j, which prints Worker logs into a public run log", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });
});

describe("env levels and values", () => {
  test("accepts DO_NOT_TRACK at job level", () => {
    const yaml = `
name: t
on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      DO_NOT_TRACK: "1"
    steps:
      - name: s
        run: bunx alchemy deploy
`;
    expect(checkWorkflow("w", yaml)).toEqual([]);
  });

  test.each(["0", "true"])("flags the value %j at the package-script prefix", (value) => {
    expect(
      checkPackageScripts("p", manifest({ x: `DO_NOT_TRACK=${value} bun alchemy deploy` })),
    ).toHaveLength(1);
  });

  test.each([
    "DO_NOT_TRACK=1 DO_NOT_TRACK=0 bun alchemy deploy",
    "DO_NOT_TRACK=1 X=1 DO_NOT_TRACK= bun alchemy deploy",
  ])("flags %j, whose last assignment turns telemetry on", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });

  test("passes when the last assignment turns telemetry off", () => {
    expect(
      checkPackageScripts("p", manifest({ x: "DO_NOT_TRACK=0 DO_NOT_TRACK=1 bun alchemy deploy" })),
    ).toEqual([]);
  });

  test("flags an inline value that turns telemetry back on under a workflow env of 1", () => {
    expect(
      checkWorkflow("w", blockWorkflow(TRACK_OFF, "", ["DO_NOT_TRACK=0 bunx alchemy deploy"])),
    ).toHaveLength(1);
  });

  test.each(["0", "true"])("flags the value %j in the workflow env", (value) => {
    expect(
      checkWorkflow(
        "w",
        blockWorkflow(`env:\n  DO_NOT_TRACK: "${value}"`, "", ["bunx alchemy deploy"]),
      ),
    ).toHaveLength(1);
  });

  test.each(["0", "true"])("flags the value %j in the step env", (value) => {
    expect(
      checkWorkflow(
        "w",
        blockWorkflow("", `        env:\n          DO_NOT_TRACK: "${value}"`, [
          "bunx alchemy deploy",
        ]),
      ),
    ).toHaveLength(1);
  });

  test("flags a two-line run where only one Alchemy line has the prefix", () => {
    expect(
      checkWorkflow(
        "w",
        blockWorkflow("", "", ["DO_NOT_TRACK=1 bunx alchemy state ls", "bunx alchemy deploy"]),
      ),
    ).toHaveLength(1);
  });

  test("lets a step's own DO_NOT_TRACK override the workflow's", () => {
    expect(
      checkWorkflow(
        "w",
        blockWorkflow(TRACK_OFF, '        env:\n          DO_NOT_TRACK: "0"', [
          "bunx alchemy deploy",
        ]),
      ),
    ).toHaveLength(1);
  });
});
