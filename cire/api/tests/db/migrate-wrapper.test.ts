import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/cire-db-migrate.ts against a real local D1, through the wrangler
// cire/api installs: the `--json` output it parses, and the schema D1 stores
// for the baseline, which its check compares with the baseline's own text.
// The script's own tests use a stand-in wrangler, so a wrangler upgrade that
// changed either would first show up here rather than as a red deploy.
//
// Each run starts wrangler and workerd, a few seconds apiece, so this runs in
// the D1 tier only: `bun run test:d1` sets CIRE_D1_TIER.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "cire-db-migrate.ts");
const CIRE_API = join(REPO_ROOT, "cire", "api");

let persist: string;

beforeAll(() => {
  persist = mkdtempSync(join(tmpdir(), "cire-db-migrate-d1-"));
});

afterAll(() => {
  rmSync(persist, { recursive: true, force: true });
});

const target = () => ["cire-db", "--local", "--persist-to", persist];

function migrate(): { readonly exitCode: number; readonly output: string } {
  const result = Bun.spawnSync([process.execPath, "run", SCRIPT, ...target()], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function execute(sql: string): void {
  const result = Bun.spawnSync(
    [
      join(CIRE_API, "node_modules", ".bin", "wrangler"),
      "d1",
      "execute",
      ...target(),
      "--command",
      sql,
    ],
    { cwd: CIRE_API, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
}

describe.skipIf(process.env.CIRE_D1_TIER !== "1")("cire-db-migrate.ts on a local D1", () => {
  test("applies the baseline to a fresh database, then passes it, then refuses it once it differs", () => {
    const fresh = migrate();
    expect(fresh.output).toContain("a fresh database");
    expect(fresh.exitCode).toBe(0);

    const again = migrate();
    expect(again.output).toContain("built from this baseline");
    expect(again.output).toContain("No migrations to apply");
    expect(again.exitCode).toBe(0);

    execute("DROP INDEX sessions_token_unique");
    const differs = migrate();
    expect(differs.output).toContain("older baseline");
    expect(differs.output).toContain("sessions_token_unique");
    expect(differs.exitCode).toBe(1);

    execute(
      "INSERT INTO d1_migrations (name) VALUES ('0058_gift_summary_and_stripe_state.sql'), ('0080_rsvp_organiser_attribution.sql')",
    );
    const partWay = migrate();
    expect(partWay.output).toContain("0059_rsvp_dietary_presets.sql");
    expect(partWay.output).toContain("0081_owner_notice_budget.sql");
    expect(partWay.exitCode).toBe(1);
  }, 60_000);
});
