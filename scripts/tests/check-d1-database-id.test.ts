import { expect, test } from "bun:test";

import { checkD1 } from "../check-d1-database-id";

const good = `
[[d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "6e835474-e0a7-4db9-8883-3247c3c891cd"

[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db-prod"
database_id = "bf0510eb-6998-4ee3-b5a0-833c646ef855"
`;

test("a config with real UUIDs everywhere passes", () => {
  expect(checkD1(good)).toEqual([]);
});

test("catches the scaffold sentinel", () => {
  const toml = good.replace(
    "6e835474-e0a7-4db9-8883-3247c3c891cd",
    "placeholder-replace-after-d1-create",
  );

  expect(checkD1(toml)).toEqual([
    {
      where: "top level",
      problem: 'cire-db: database_id is a placeholder ("placeholder-replace-after-d1-create")',
    },
  ]);
});

test("catches an empty database_id", () => {
  const toml = good.replace("6e835474-e0a7-4db9-8883-3247c3c891cd", "   ");

  expect(checkD1(toml)).toEqual([
    { where: "top level", problem: "cire-db: database_id is empty or missing" },
  ]);
});

// The greps this replaced matched a `database_id` line. A value that is neither
// a placeholder nor empty but also not an id — a name pasted into the wrong
// field, a truncated copy — satisfied all three of them.
test("catches a database_id that is not a UUID at all", () => {
  const toml = good.replace("6e835474-e0a7-4db9-8883-3247c3c891cd", "cire-db");

  expect(checkD1(toml)).toEqual([
    { where: "top level", problem: 'cire-db: database_id is not a UUID ("cire-db")' },
  ]);
});

// The shape no grep could see, and the one wrangler makes easy to hit:
// cire/api/wrangler.toml records that named environments do NOT inherit the
// top-level [[d1_databases]] block. Delete it from an env and every remaining
// database_id in the file is valid while that env has no database.
test("catches a named environment with no D1 binding at all", () => {
  const toml = `
[[d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "6e835474-e0a7-4db9-8883-3247c3c891cd"

[env.production.vars]
SOMETHING = "set"
`;

  expect(checkD1(toml)).toEqual([
    { where: "[env.production]", problem: "no [[d1_databases]] binding" },
  ]);
});

test("reports every bad binding, not just the first", () => {
  const toml = good
    .replace("6e835474-e0a7-4db9-8883-3247c3c891cd", "placeholder-x")
    .replace("bf0510eb-6998-4ee3-b5a0-833c646ef855", "");

  expect(checkD1(toml)).toHaveLength(2);
});

// Guard against the guard passing on a file it failed to understand.
test("a config with no D1 anywhere is a finding, not a pass", () => {
  expect(checkD1('name = "cire-api"\n')).toEqual([
    { where: "top level", problem: "no [[d1_databases]] binding" },
  ]);
});

// The real committed config must pass — this is the regression the guard exists
// for, asserted against the actual file rather than a fixture of it.
test("the committed cire/api/wrangler.toml passes", async () => {
  const toml = await Bun.file(new URL("../../cire/api/wrangler.toml", import.meta.url)).text();

  expect(checkD1(toml)).toEqual([]);
});
