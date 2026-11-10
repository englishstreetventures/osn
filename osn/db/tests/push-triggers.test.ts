import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

// The local database `bun run dev` serves is built by `db:push`, not by the
// migrations. drizzle-kit cannot declare a trigger, so the script adds them
// after the push; without that step the local stack takes writes every other
// database refuses. Runs the package's real `db:push`, twice, as `db:reset`
// and a developer re-pushing a schema change would.

const PACKAGE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const REFUSAL = "organisation member role is not admin or member";
const EMAIL_REFUSAL = "account email is not lower case";

function push(url: string): void {
  const result = spawnSync("bun", ["run", "db:push"], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, OSN_DATABASE_URL: url },
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

it("a database built by db:push, then pushed again, refuses a member role outside the set and a capital in an email", () => {
  const dir = mkdtempSync(join(tmpdir(), "osn-db-push-"));
  try {
    const url = join(dir, "osn.db");
    push(url);
    push(url);

    const db = new Database(url);
    try {
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual([
        "accounts_email_lower_case",
        "accounts_email_lower_case_update",
        "organisation_members_role_known",
        "organisation_members_role_known_update",
      ]);

      const add = db.query(
        "INSERT INTO organisation_members (id, organisation_id, profile_id, role, created_at) VALUES (?, 'org_local', ?, ?, 1)",
      );
      expect(() => add.run("orgm_owner", "usr_owner", "owner")).toThrow(REFUSAL);
      add.run("orgm_member", "usr_member", "member");
      expect(() =>
        db.run("UPDATE organisation_members SET role = 'owner' WHERE id = 'orgm_member'"),
      ).toThrow(REFUSAL);

      const addAccount = db.query(
        "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
      );
      expect(() => addAccount.run("acc_caps", "Caps@x.com", "pku_caps")).toThrow(EMAIL_REFUSAL);
      addAccount.run("acc_plain", "plain@x.com", "pku_plain");
      expect(() =>
        db.run("UPDATE accounts SET email = 'Plain@x.com' WHERE id = 'acc_plain'"),
      ).toThrow(EMAIL_REFUSAL);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
