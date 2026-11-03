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
    "CI=true DO_NOT_TRACK=1 bun alchemy state ls --backend cloudflare",
  ])("passes %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([]);
  });

  test.each([
    "CI=true DO_NOT_TRACK=1 bun alchemy state bootstrap --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy state bootstrap --backend cloudflare --name alchemy-state-store",
  ])("G1: passes %j, which deploys or adopts the state store", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([]);
  });

  test.each([
    "CI=true DO_NOT_TRACK=1 bun alchemy state bootstrap --backend cloudflare --force",
    "DO_NOT_TRACK=1 bun alchemy state bootstrap --force --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy state bootstrap --backend cloudflare --force=true",
  ])("G1: refuses %j, which redeploys a serving state store", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });

  test.each([
    "DO_NOT_TRACK=1 bun alchemy state teardown --backend cloudflare --yes",
    "DO_NOT_TRACK=1 bun alchemy state logs --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy state logs --backend cloudflare --tail",
    "DO_NOT_TRACK=1 bun alchemy state read cire/dev --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy state delete cire/dev --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy state unsafe nuke --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy state --backend cloudflare bootstrap",
  ])("G2: refuses %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script })).length).toBeGreaterThan(0);
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
    "DO_NOT_TRACK=1 bun alchemy drift --stage dev --repair",
    "DO_NOT_TRACK=1 bun alchemy unsafe nuke",
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
    "const s = Layer.effect(State, makeHttpStateStore({ url, authToken }));",
    "const s = Layer.effect(State, makeLocalState());",
    "const s = makePostgresState(options);",
    "const s = InMemoryService(records);",
    'import { State } from "alchemy/State";',
    'import { makeBucketState } from "alchemy/State/BucketState";',
    'const S = await import("alchemy/State");',
  ])("refuses %j in a stack file", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  test.each([
    'import { state } from "@alchemy.run/cloudflare";',
    'import { providers, state } from "@alchemy.run/cloudflare";',
    'import { state } from "@alchemy.run/cloudflare/StateStore";',
    'import { bootstrap } from "@alchemy.run/cloudflare/StateStore";',
    'import { state } from "@alchemy.run/aws";',
    'import { state } from "@alchemy.run/aws/StateStore";',
    'import { postgresState } from "@alchemy.run/sql/PostgresState";',
    'const S = await import("@alchemy.run/sql/PostgresState");',
  ])("G3: refuses %j in a stack file", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  test.each([
    'import * as CF from "@alchemy.run/cloudflare"; CF.state()',
    'import * as CF from "@alchemy.run/cloudflare/StateStore"; CF.state()',
    'import * as Aws from "@alchemy.run/aws"; Aws.state()',
    'const CF = await import("@alchemy.run/cloudflare"); CF.state()',
  ])("G3: refuses a state call through a namespace import, %j", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  test("passes a stack that takes stackOptions()", () => {
    expect(
      checkStackSource("cire/infra/alchemy.run.ts", "Alchemy.Stack('cire', stackOptions(), body)"),
    ).toEqual([]);
  });

  test("G3: passes a stack that declares Cloudflare resources and takes stackOptions()", () => {
    expect(
      checkStackSource(
        "cire/infra/alchemy.run.ts",
        [
          'import * as Cloudflare from "@alchemy.run/cloudflare";',
          "Alchemy.Stack('cire', stackOptions(), Cloudflare.Worker('api', props))",
        ].join("\n"),
      ),
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
