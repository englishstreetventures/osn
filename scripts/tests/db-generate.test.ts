import { expect, test } from "bun:test";

import { applyFixups, migrationFileName, rebuildReason, refuseName } from "../db-generate";

// ── the migration's name ─────────────────────────────────────────────────────

test("refuseName accepts snake_case", () => {
  expect(refuseName("event_venue_name")).toBeNull();
  expect(refuseName("seating2")).toBeNull();
});

test("refuseName refuses anything a timestamped file name could not carry", () => {
  for (const bad of [
    "",
    "EventVenue",
    "event-venue",
    "event venue",
    "_leading",
    "trailing_",
    "a__b",
  ]) {
    expect(refuseName(bad)).not.toBeNull();
  }
});

test("migrationFileName stamps the UTC time, whatever the local zone", () => {
  // 00:30 on 1 January in UTC is still 31 December in the Americas and already
  // the afternoon in Australia; the stamp must be the UTC one either way.
  expect(migrationFileName(new Date("2027-01-01T00:30:05Z"), "x")).toBe("20270101003005_x.sql");
});

// ── refusals ─────────────────────────────────────────────────────────────────

test("rebuildReason refuses a copy-and-swap table rebuild", () => {
  const rebuild =
    "PRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_users` (`id` text);\nINSERT INTO `__new_users` SELECT * FROM `users`;";
  expect(rebuildReason(rebuild)).toContain("__new_users");
});

test("rebuildReason refuses a migration that switches foreign keys off on its own", () => {
  expect(rebuildReason("PRAGMA foreign_keys = OFF;")).not.toBeNull();
});

test("rebuildReason lets an ordinary ALTER through", () => {
  expect(rebuildReason("ALTER TABLE `users` ADD `bio` text;")).toBeNull();
});

// ── fix-ups ──────────────────────────────────────────────────────────────────

test("applyFixups makes a text primary key NOT NULL, as SQLite will not on its own", () => {
  expect(applyFixups("CREATE TABLE `t` (\n\t`id` text PRIMARY KEY,\n\t`n` integer\n);")).toBe(
    "CREATE TABLE `t` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`n` integer\n);",
  );
});

test("applyFixups leaves an integer primary key alone, and one already NOT NULL", () => {
  const sql =
    "CREATE TABLE `t` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`k` text PRIMARY KEY NOT NULL\n);";
  expect(applyFixups(sql)).toBe(sql);
});

test("applyFixups writes a boolean default as 1 or 0, not as a word", () => {
  expect(
    applyFixups(
      "ALTER TABLE `t` ADD `a` integer DEFAULT true NOT NULL;\nALTER TABLE `t` ADD `b` integer DEFAULT false;",
    ),
  ).toBe(
    "ALTER TABLE `t` ADD `a` integer DEFAULT 1 NOT NULL;\nALTER TABLE `t` ADD `b` integer DEFAULT 0;",
  );
});

test("applyFixups leaves a string default that merely contains the word alone", () => {
  const sql = "ALTER TABLE `t` ADD `a` text DEFAULT 'true';";
  expect(applyFixups(sql)).toBe(sql);
});
