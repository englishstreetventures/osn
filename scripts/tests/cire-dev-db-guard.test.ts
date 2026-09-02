// Tests for cire-dev-db-guard.ts.
//
// This guard is the only thing between an unattended CI `DROP TABLE` loop and
// the live-wedding D1, and a weakened guard's failure mode is *passing* — so
// every refusal branch gets its own case. From outside, all five failures look
// alike; only a test can tell them apart.
import { expect, test } from "bun:test";

import { assertCireDevDb } from "../cire-dev-db-guard";

const DEV_ID = "bf0510eb-6998-4ee3-b5a0-833c646ef855";
const PROD_ID = "6e835474-e0a7-4db9-8883-3247c3c891cd";

test("dev block alone passes", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${DEV_ID}"
`;
  expect(assertCireDevDb(toml).ok).toBe(true);
});

test("dev and production with distinct ids passes", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${DEV_ID}"

[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "${PROD_ID}"
`;
  expect(assertCireDevDb(toml).ok).toBe(true);
});

test("dev names the production database is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "${PROD_ID}"
`;
  expect(assertCireDevDb(toml).ok).toBe(false);
});

test("dev block has no database_id is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
`;
  expect(assertCireDevDb(toml).ok).toBe(false);
});

test("no dev block at all is refused", () => {
  const toml = `
[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "${PROD_ID}"
`;
  expect(assertCireDevDb(toml).ok).toBe(false);
});

test("production sharing the dev id is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${DEV_ID}"

[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "${DEV_ID}"
`;
  const result = assertCireDevDb(toml);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toBe(
      `database_id ${DEV_ID} appears 2 times — the dev tier is sharing a database with another environment. Refusing.`,
    );
  }
});

// The evasion the awk version shipped with: extraction stripped any quote, the
// shared-id check matched a hard-coded double-quoted id. TOML accepts both
// forms, so a single-quoted production id sharing the dev database passed
// clean — and the next CI step dropped every table. `Bun.TOML.parse()` reads
// both quote styles into the same string, so there is no extraction step left
// to disagree with the comparison.
test("production sharing the dev id, single-quoted, is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${DEV_ID}"

[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = '${DEV_ID}'
`;
  expect(assertCireDevDb(toml).ok).toBe(false);
});

test("dev block itself single-quoted passes", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = 'cire-db-dev'
database_id = '${DEV_ID}'
`;
  expect(assertCireDevDb(toml).ok).toBe(true);
});

test("top-level local block sharing the dev id is refused", () => {
  const toml = `
[[d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "${DEV_ID}"

[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${DEV_ID}"
`;
  expect(assertCireDevDb(toml).ok).toBe(false);
});

test("trailing comment on the dev id passes", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"  # disposable
database_id = "${DEV_ID}"  # reset on every merge
`;
  expect(assertCireDevDb(toml).ok).toBe(true);
});

// `database_name` is a label; wrangler targets `database_id`. So the dangerous
// fixture is not a block that admits it points at production — it is one that
// says "cire-db-dev" over the live-wedding id. Only the pinned id catches this.
test("dev names cire-db-dev over the production id is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${PROD_ID}"
`;
  const result = assertCireDevDb(toml);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toBe(
      `[env.dev] points at the PRODUCTION database (${PROD_ID}) under the name 'cire-db-dev'. Refusing.`,
    );
  }
});

// Any id that is not the pinned one, even a plausible unknown, is refused: an
// unrecognised database might be anything, and the guard's job is to be sure.
test("dev pointing at an unrecognised database is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "00000000-1111-2222-3333-444444444444"
`;
  expect(assertCireDevDb(toml).ok).toBe(false);
});

// The awk version anchored its block-terminator at `/^\[/`, so an indented
// table header (legal TOML) did not end the walk and the dev block
// "inherited" the next block's database_id — here that would have yielded the
// dev id from a PRODUCTION block, unique in the file, a clean pass straight
// into the drop loop. `Bun.TOML.parse()` reads structure, not indentation, so
// this fixture is refused for the ordinary reason (no database_id in
// [env.dev]) rather than leaking into the next table.
test("an indented header after a dev block with no id is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"

  [[env.production.d1_databases]]
  binding = "DB"
  database_name = "cire-db"
  database_id = "${DEV_ID}"
`;
  expect(assertCireDevDb(toml).ok).toBe(false);
});

test("the committed cire/api/wrangler.toml passes", async () => {
  const toml = await Bun.file(new URL("../../cire/api/wrangler.toml", import.meta.url)).text();
  const result = assertCireDevDb(toml);
  expect(result.ok).toBe(true);
});

// Both callers pass the database to wrangler by NAME, so a second binding
// wearing the dev name is a second candidate target — and the id checks above
// only ever looked at [env.dev]'s first binding. These two fixtures are the
// only ones where the file is internally consistent (the dev block is exactly
// right) and the guard must still refuse.
test("another env carrying the dev name over a different id is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${DEV_ID}"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${PROD_ID}"
`;
  const result = assertCireDevDb(toml);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("[env.staging] carries a second D1 named 'cire-db-dev'");
  }
});

test("a second binding inside [env.dev] itself wearing the dev name is refused", () => {
  const toml = `
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "${DEV_ID}"

[[env.dev.d1_databases]]
binding = "DB_LEGACY"
database_name = "cire-db-dev"
database_id = "${PROD_ID}"
`;
  expect(assertCireDevDb(toml).ok).toBe(false);
});
