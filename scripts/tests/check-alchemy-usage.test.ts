import { describe, expect, test } from "bun:test";

import {
  checkCompositeAction,
  checkPackageScripts,
  checkScriptsRunAsCi,
  checkStackSource,
  checkWorkflow,
  LOG_FORMAT_WHY,
  LOG_LEVEL_WHY,
  LOG_VARIABLE_WHY,
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
    "DO_NOT_TRACK=1 bun alchemy state migrate --backend cloudflare",
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

describe("shell quoting", () => {
  // The rules read the words the shell hands Alchemy, not the text as typed.
  test.each([
    'DO_NOT_TRACK=1 bun alchemy state bootstrap --backend cloudflare "--force"',
    "DO_NOT_TRACK=1 bun alchemy state bootstrap --backend cloudflare --forc\\e",
    "DO_NOT_TRACK=1 bun alchemy state bootstrap --backend cloudflare '--force=true'",
    'DO_NOT_TRACK=1 bun alchemy "state" read cire/dev --backend cloudflare',
    "DO_NOT_TRACK=1 bun alchemy 'state' read cire/dev",
    'DO_NOT_TRACK=1 bun alchemy st"at"e read cire/dev',
    "DO_NOT_TRACK=1 bun alchemy $'state' read cire/dev",
    'DO_NOT_TRACK=1 bun alchemy "state"',
    'DO_NOT_TRACK=1 bun alchemy "logs" --stage dev',
    'DO_NOT_TRACK=1 bun "alchemy" state read cire/dev',
    "DO_NOT_TRACK=1 bun al\\chemy state read cire/dev",
  ])("refuses %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });

  test.each([
    'FOO="x DO_NOT_TRACK=1" bun alchemy deploy --stage dev',
    "FOO='x DO_NOT_TRACK=1' bun alchemy deploy --stage dev",
    "FOO=x\\ DO_NOT_TRACK=1 bun alchemy deploy --stage dev",
  ])("flags %j, whose quoted value sets FOO alone and leaves telemetry on", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([
      { where: "p scripts.x", problem: "an Alchemy command must start with DO_NOT_TRACK=1" },
    ]);
  });

  test("refuses a destroy whose quoted stage holds two words", () => {
    expect(
      checkPackageScripts(
        "p",
        manifest({ x: 'DO_NOT_TRACK=1 bun alchemy destroy --stage "pr-7 dev"' }),
      ),
    ).toHaveLength(1);
  });

  test.each([
    'DO_NOT_TRACK="1" bun alchemy state ls --backend cloudflare',
    "DO_NOT_TRACK='1' bun alchemy state ls --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy deploy --stage 'pr-7' --yes",
    "DO_NOT_TRACK=1 bun alchemy deploy --stage dev --name '$literal'",
  ])("passes %j, which the shell reads as an allowed command", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([]);
  });

  test.each([
    "DO_NOT_TRACK=1 bun alchemy {state,} read cire/dev",
    "DO_NOT_TRACK=1 bun alchemy deploy --stage {dev,production}",
    "DO_NOT_TRACK=1 bun alchemy deploy --stage pr-{1..3}",
    "DO_NOT_TRACK=1 bun alchemy $CMD read cire/dev",
    'DO_NOT_TRACK=1 bun alchemy deploy --stage "$STAGE"',
    "DO_NOT_TRACK=1 bun alchemy $(echo state) read cire/dev",
    "DO_NOT_TRACK=1 bun alchemy `echo state` read cire/dev",
    'DO_NOT_TRACK=1 bun alchemy "`echo logs`"',
  ])("refuses %j, whose arguments use a shell expansion the guard cannot read", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([
      {
        where: "p scripts.x",
        problem: "an Alchemy command's arguments use a shell expansion the guard cannot read",
      },
    ]);
  });

  test("reads the words of a workflow step as the shell does", () => {
    expect(
      checkWorkflow("w", blockWorkflow(TRACK_OFF, "", ['bunx alchemy "state" read cire'])),
    ).toHaveLength(1);
  });
});

describe("checkScriptsRunAsCi", () => {
  // A package script runs on a laptop as well as in CI. With CI unset, Alchemy
  // deploys a missing state store from a plan and reads a stored profile.
  test.each([
    "CI=true DO_NOT_TRACK=1 bun alchemy plan --stage dev",
    "DO_NOT_TRACK=1 CI=true bun alchemy deploy --stage dev --yes",
    "CI=false CI=true DO_NOT_TRACK=1 bun alchemy state ls --backend cloudflare",
    'CI="true" DO_NOT_TRACK=1 bun alchemy plan --stage dev',
    "CI=true DO_NOT_TRACK=1 bun alchemy state ls && CI=true DO_NOT_TRACK=1 bun alchemy plan --stage dev",
    "bunx --bun vitest",
    "bun run scripts/plan-guard.ts",
  ])("passes %j", (script) => {
    expect(checkScriptsRunAsCi("p", manifest({ x: script }))).toEqual([]);
  });

  test.each([
    "DO_NOT_TRACK=1 bun alchemy plan --stage dev",
    "DO_NOT_TRACK=1 bun alchemy deploy --stage production --dry-run",
    "CI=1 DO_NOT_TRACK=1 bun alchemy plan --stage dev",
    "CI=false DO_NOT_TRACK=1 bun alchemy deploy --stage dev --yes",
    "CI=true CI= DO_NOT_TRACK=1 bun alchemy plan --stage dev",
    'FOO="x CI=true" DO_NOT_TRACK=1 bun alchemy plan --stage dev',
    "CI=true DO_NOT_TRACK=1 bun alchemy state ls && DO_NOT_TRACK=1 bun alchemy plan --stage dev",
  ])("flags %j", (script) => {
    expect(checkScriptsRunAsCi("p", manifest({ x: script }))).toEqual([
      { where: "p scripts.x", problem: "an Alchemy package script must set CI=true" },
    ]);
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

  // Each module hands out a state store's layer, its lifecycle (bootstrap,
  // teardown, logs) or a command that does: named, namespace, default and
  // dynamic imports of any of them are refused.
  test.each([
    'import { stateStore } from "@alchemy.run/cloudflare/Alchemist"; const s = stateStore.layer;',
    'import { bootstrap } from "@alchemy.run/cloudflare/Alchemist";',
    'import { lifecycle } from "@alchemy.run/cloudflare/Alchemist"; lifecycle.teardown({});',
    'import { Token } from "@alchemy.run/cloudflare/Alchemist"; Token.create({});',
    'import * as A from "@alchemy.run/cloudflare/Alchemist"; const s = A.stateStore.layer;',
    'const A = await import("@alchemy.run/cloudflare/Alchemist"); A.stateStore.layer;',
    'import { stateStore } from "@alchemy.run/cloudflare/Alchemist/StateStore";',
    'import Contributions from "@alchemy.run/cloudflare/Contributions";',
    'import * as C from "@alchemy.run/cloudflare/Contributions"; C.default.stateStores;',
    'const C = await import("@alchemy.run/cloudflare/Contributions");',
    'import { tokenCommand } from "@alchemy.run/cloudflare/Cli";',
    'const Cli = await import("@alchemy.run/cloudflare/Cli");',
    'import { stateStore } from "@alchemy.run/aws/Alchemist";',
    'import Contributions from "@alchemy.run/aws/Contributions";',
    'import { stateStores } from "alchemy/Contributions";',
    'import * as C from "alchemy/Contributions"; C.stateStores();',
    'const C = await import("alchemy/Contributions");',
    'import { teardown } from "alchemy/Alchemist/routes/state";',
    'import * as R from "alchemy/Alchemist/routes/state"; R.layer;',
    'const R = await import("alchemy/Alchemist/routes/state");',
    'import { Alchemist } from "alchemy/Alchemist";',
    'import { stateCommand } from "alchemy/Cli/commands/state";',
    'import * as S from "alchemy/State"; S.State;',
  ])("G3: refuses the state store module in %j", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  // The provider's root exports `state()`, which builds a state store layer,
  // and `bootstrap()`, which deploys a store: no binding of either passes.
  test.each([
    'const { state } = await import("@alchemy.run/cloudflare"); const s = state();',
    'import * as CF from "@alchemy.run/cloudflare"; const { state: pick } = CF; pick();',
    'import * as CF from "@alchemy.run/cloudflare"; const { providers, state } = CF;',
    'import * as CF from "@alchemy.run/cloudflare"; const {\n  state,\n} = CF;',
    'import * as CF from "@alchemy.run/cloudflare"; const { state = fallback } = CF;',
    'import * as CF from "@alchemy.run/cloudflare"; const { "state": s } = CF;',
    'const { default: { state } } = await import("@alchemy.run/cloudflare");',
    'import("@alchemy.run/cloudflare").then(({ state }) => state());',
    'import * as CF from "@alchemy.run/cloudflare"; CF["state"]();',
    "import * as CF from \"@alchemy.run/cloudflare\"; CF['state']();",
    'import * as CF from "@alchemy.run/cloudflare"; const s = CF.state;',
    'import * as CF from "@alchemy.run/cloudflare"; const s = CF?.state;',
    'import * as Cloudflare from "@alchemy.run/cloudflare"; Effect.runPromise(Cloudflare.bootstrap({ force: true }));',
    'import { bootstrap } from "@alchemy.run/cloudflare";',
    'import { bootstrap as b } from "@alchemy.run/cloudflare";',
    'import * as CF from "@alchemy.run/cloudflare"; const { bootstrap } = CF;',
    'import * as CF from "@alchemy.run/cloudflare"; CF["bootstrap"]({});',
    'export * from "@alchemy.run/cloudflare";',
    'export * as CF from "@alchemy.run/cloudflare";',
    'export { state } from "@alchemy.run/cloudflare";',
  ])("G3: refuses %j", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  // Alchemy's root module exports its local and in-memory stores as well.
  test.each([
    'import * as Alchemy from "alchemy"; const { localState: l } = Alchemy; l();',
    'import * as Alchemy from "alchemy"; Alchemy["inMemoryState"]();',
    'import * as Alchemy from "alchemy"; const s = Alchemy.localState;',
    'import { localState as l } from "alchemy";',
  ])("refuses a state constructor taken without a call, %j", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  test("G3: passes a stack that names state only in prose and takes stackOptions()", () => {
    expect(
      checkStackSource(
        "cire/infra/alchemy.run.ts",
        [
          'import * as Cloudflare from "@alchemy.run/cloudflare";',
          "// Logical ids key the state rows, so they never change.",
          "Alchemy.Stack('cire', stackOptions(), Cloudflare.Worker('api', { name: 'state-api' }))",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("passes a state binding in a file that names no provider module", () => {
    expect(
      checkStackSource("cire/infra/src/seeds.ts", "const { state } = readSeed(); use(state);"),
    ).toEqual([]);
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

describe("console log settings that reach a public run log", () => {
  const problems = (findings: readonly { readonly problem: string }[]) =>
    findings.map((finding) => finding.problem);

  test.each([
    "CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev --log-level debug",
    "CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev --log-level=trace",
    "CI=true DO_NOT_TRACK=1 bun alchemy --log-level ALL plan --stage dev",
    'CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev --log-level "debug"',
    'bun run deploy:dev -- --log-level "$LEVEL"',
    "bun run deploy:dev -- --log-level debug",
  ])("refuses %j, which prints Debug records or a level it cannot read", (script) => {
    expect(problems(checkPackageScripts("p", manifest({ x: script })))).toEqual([LOG_LEVEL_WHY]);
  });

  test.each([
    "CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage production --dry-run --log-format json",
    "CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev --log-format=json",
    "CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev --log-format 'json'",
    "bun run plan:production -- --log-format json",
  ])("refuses %j, under which Alchemy prints no plan", (script) => {
    expect(problems(checkPackageScripts("p", manifest({ x: script })))).toEqual([LOG_FORMAT_WHY]);
  });

  test.each([
    "CI=true DO_NOT_TRACK=1 ALCHEMY_LOG_LEVEL=debug bun alchemy plan --stage dev",
    "CI=true DO_NOT_TRACK=1 ALCHEMY_LOG_LEVEL='debug' bun alchemy plan --stage dev",
    "CI=true DO_NOT_TRACK=1 env ALCHEMY_LOG_LEVEL=debug bun alchemy plan --stage dev",
    "export ALCHEMY_LOG_LEVEL=debug && CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev",
    "CI=true DO_NOT_TRACK=1 ALCHEMY_LOG_FORMAT=pretty bun alchemy plan --stage dev",
    "ALCHEMY_LOG_FORMAT=json bun run plan:dev",
    "ALCHEMY_LOG_LEVEL=$LEVEL bun run deploy:dev",
  ])("refuses %j, whose variable reaches runs the guard cannot follow", (script) => {
    expect(problems(checkPackageScripts("p", manifest({ x: script })))).toEqual([LOG_VARIABLE_WHY]);
  });

  test.each([
    "CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev --log-level info",
    "CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev --log-level=warn",
    "CI=true DO_NOT_TRACK=1 bun alchemy --log-level info plan --stage dev",
    "CI=true DO_NOT_TRACK=1 bun alchemy deploy --stage dev --log-format pretty",
    "bun run deploy:dev -- --log-level error",
  ])("passes %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([]);
  });

  const DEPLOY = ["bun alchemy deploy --stage dev --yes"];

  test("refuses either variable in the workflow, a job or a step env, each where it is set, whatever the value", () => {
    expect(
      checkWorkflow(
        "w",
        blockWorkflow('env:\n  DO_NOT_TRACK: "1"\n  ALCHEMY_LOG_LEVEL: debug', "", DEPLOY),
      ),
    ).toEqual([{ where: "w env", problem: LOG_VARIABLE_WHY }]);
    expect(
      checkWorkflow(
        "w",
        blockWorkflow(TRACK_OFF, "        env:\n          ALCHEMY_LOG_FORMAT: pretty", DEPLOY),
      ),
    ).toEqual([{ where: "w jobs.a.steps[0].env", problem: LOG_VARIABLE_WHY }]);
    expect(
      checkWorkflow(
        "w",
        blockWorkflow('env:\n  DO_NOT_TRACK: "1"\n  ALCHEMY_LOG_LEVEL: ${{ vars.LEVEL }}', "", [
          "bun run deploy:dev",
        ]),
      ),
    ).toEqual([{ where: "w env", problem: LOG_VARIABLE_WHY }]);
    const jobEnv = `
name: t
on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      DO_NOT_TRACK: "1"
      ALCHEMY_LOG_LEVEL: info
    steps:
      - run: bun alchemy deploy --stage dev --yes
`;
    expect(checkWorkflow("w", jobEnv)).toEqual([
      { where: "w jobs.a.env", problem: LOG_VARIABLE_WHY },
    ]);
  });

  test("refuses a job env that sets a low level on a step that runs Alchemy through a package script", () => {
    const viaScript = `
name: t
on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      ALCHEMY_LOG_LEVEL: debug
    steps:
      - env:
          DO_NOT_TRACK: "1"
        run: bun run deploy:dev 2>&1 | tee "$RUNNER_TEMP/alchemy.log"
`;
    expect(checkWorkflow("w", viaScript)).toEqual([
      { where: "w jobs.a.env", problem: LOG_VARIABLE_WHY },
    ]);
  });

  test.each([
    { lines: ["export ALCHEMY_LOG_LEVEL=debug", "bun alchemy deploy --stage dev --yes"] },
    { lines: ['echo "ALCHEMY_LOG_LEVEL=debug" >> "$GITHUB_ENV"'] },
  ])("refuses a step whose commands name either variable, $lines", ({ lines }) => {
    expect(problems(checkWorkflow("w", blockWorkflow(TRACK_OFF, "", lines)))).toEqual([
      LOG_VARIABLE_WHY,
    ]);
  });

  test("refuses a step that passes a package script a low log level", () => {
    expect(
      problems(
        checkWorkflow(
          "w",
          blockWorkflow(TRACK_OFF, "", ["bun run deploy:dev -- --log-level debug"]),
        ),
      ),
    ).toEqual([LOG_LEVEL_WHY]);
  });

  test("refuses either variable in a composite action's step env", () => {
    const action = `
name: a
runs:
  using: composite
  steps:
    - shell: bash
      env:
        DO_NOT_TRACK: "1"
        ALCHEMY_LOG_FORMAT: json
      run: bun alchemy deploy --stage dev --yes
`;
    expect(checkCompositeAction("a", action)).toEqual([
      { where: "a runs.steps[0].env", problem: LOG_VARIABLE_WHY },
    ]);
  });

  test("refuses makeBucketState in a stack file, called or not", () => {
    expect(
      checkStackSource("cire/infra/alchemy.run.ts", "const s = makeBucketState({ bucket });"),
    ).toHaveLength(1);
    expect(
      checkStackSource("cire/infra/alchemy.run.ts", "const make = makeBucketState;"),
    ).toHaveLength(1);
  });
});
