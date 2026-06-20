// Derives seed/dev-seed.sql from the canonical seed data in ./data. Run with
// `bun run --cwd cire/db seed:generate` after editing anything under ./data —
// the SQL is generated, never hand-edited. seed.test.ts fails CI if the
// committed dev-seed.sql drifts from what this emits.
//
//   bun run --cwd cire/db seed:generate         # regenerate dev-seed.sql
//
// The output is byte-for-byte deterministic so the in-repo file is a pure
// function of ./data.

import { bootstrapWedding, events, guests } from "./data";

// SQL single-quote escaping: double any embedded apostrophe.
const sql = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const HEADER = `-- Local D1 dev seed for \`bun run db:seed\`.
--
-- GENERATED FILE — do not edit by hand. Regenerate with:
--   bun run --cwd cire/db seed:generate
-- The single source of truth is cire/db/seed/data/ (events.ts, guests.ts,
-- wedding.ts), which cire/api/src/db/setup.ts#seedDb also reads, so the test
-- fixtures and this SQL can no longer drift. seed.test.ts fails CI on drift.
--
-- Idempotent — every INSERT uses \`OR IGNORE\` so re-running on top of an
-- existing seed is a no-op (PK / unique-index conflicts are skipped). To
-- pick up edits to existing rows, use \`bun run db:reset\` instead which
-- wipes local D1 state then re-pushes + re-seeds.`;

const RULE = "-- ────────────────────────────────────────────────────────────────────────────";

function weddingBlock(): string {
  return `${RULE}
-- Sample wedding (local dev only)
${RULE}

-- Migration 0006 seeded \`wed_bootstrap\`, but migration 0015 deletes it (prod
-- starts clean — every real OSN user creates their own weddings). So the local
-- dev seed now owns its sample wedding row outright instead of relying on the
-- migration's seeded row. Owned by the fixed dev id \`${bootstrapWedding.ownerOsnProfileId}\`
-- (DEV_OWNER_PROFILE_ID in cire/db/seed/data/wedding.ts) so a signed-in dev
-- account can own it; override the owner after seeding via
-- CIRE_DEV_OWNER_PROFILE_ID (see scripts/cire-db-seed.sh). The events/families
-- below are FK-scoped to it.
INSERT OR IGNORE INTO weddings (id, slug, display_name, owner_osn_profile_id, code_style, created_at, updated_at)
VALUES (${sql(bootstrapWedding.id)}, ${sql(bootstrapWedding.slug)}, ${sql(bootstrapWedding.displayName)}, ${sql(bootstrapWedding.ownerOsnProfileId)}, ${sql(bootstrapWedding.codeStyle)}, unixepoch(), unixepoch());`;
}

function eventsBlock(): string {
  const rows = Object.values(events).map((event) => {
    const palette = JSON.stringify(
      event.dressCodePalette.map((swatch) => ({ name: swatch.name, color: swatch.color })),
    );
    return `  (
    ${sql(event.id)}, ${sql(bootstrapWedding.id)}, ${sql(event.slug)}, ${sql(event.name)},
    ${sql(event.date)}, ${sql(event.location)},
    ${sql(event.description)},
    ${sql(event.startAt)}, ${sql(event.endAt)}, ${sql(event.timezone)},
    ${sql(event.address)},
    ${sql(event.dressCodeDescription)},
    ${sql(palette)},
    ${sql(event.pinterestUrl)},
    ${sql(event.mapsUrl)},
    ${event.sortOrder}
  )`;
  });

  return `${RULE}
-- Events (${rows.length}) — Oct–Nov 2026, Sydney
${RULE}

-- All events/families are scoped to the sample wedding above (\`${bootstrapWedding.id}\`).
-- The wedding_id column is NOT NULL with an FK, so the seed supplies it
-- explicitly.
INSERT OR IGNORE INTO events (
  id, wedding_id, slug, name, date, location, description,
  start_at, end_at, timezone, address,
  dress_code_description, dress_code_palette,
  pinterest_url, maps_url, sort_order
) VALUES
${rows.join(",\n")};`;
}

function familiesBlock(): string {
  const rows = guests.map(
    (family) =>
      `  (${sql(family.id)}, ${sql(bootstrapWedding.id)}, ${sql(family.publicId)}, ${sql(family.familyName)}, unixepoch() * 1000, unixepoch() * 1000)`,
  );
  return `${RULE}
-- Families (${rows.length}) — stable UUIDs so dev links don't drift between seeds
${RULE}

INSERT OR IGNORE INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES
${rows.join(",\n")};`;
}

function guestsBlock(): string {
  const rows: string[] = [];
  for (const family of guests) {
    rows.push(`  -- ${family.familyName}`);
    family.guests.forEach((guest, index) => {
      rows.push(
        `  (${sql(guest.id)}, ${sql(family.id)}, ${sql(guest.firstName)}, ${sql(guest.lastName)}, ${index}, unixepoch() * 1000, unixepoch() * 1000)`,
      );
    });
  }
  // Re-join with commas only between the value rows (comment lines are not
  // value rows). We render the value rows comma-separated and append the
  // trailing semicolon; comment lines sit on their own line.
  const total = guests.reduce((n, f) => n + f.guests.length, 0);
  const body = renderCommentedValueRows(rows);
  return `${RULE}
-- Guests (${total})
${RULE}

INSERT OR IGNORE INTO guests (id, family_id, first_name, last_name, sort_order, created_at, updated_at) VALUES
${body};`;
}

// Joins value rows with ",\n" while leaving "-- comment" lines un-suffixed and
// followed by a bare newline (matching the hand-written layout).
function renderCommentedValueRows(lines: readonly string[]): string {
  const valueIndices = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => !line.trimStart().startsWith("--"))
    .map(({ i }) => i);
  const lastValue = valueIndices.at(-1);
  return lines
    .map((line, i) => {
      const isComment = line.trimStart().startsWith("--");
      if (isComment) return `${line}\n`;
      const suffix = i === lastValue ? "" : ",\n";
      return `${line}${suffix}`;
    })
    .join("");
}

function guestEventsBlock(): string {
  const lines: string[] = [];
  for (const family of guests) {
    for (const guest of family.guests) {
      lines.push(`  -- ${guest.firstName}: ${describeEvents(guest.events)}`);
      for (const eventId of guest.events) {
        lines.push(`  (${sql(guest.id)}, ${sql(eventId)})`);
      }
    }
  }
  const body = renderCommentedValueRows(lines);
  return `${RULE}
-- Event invitations
${RULE}

INSERT OR IGNORE INTO guest_events (guest_id, event_id) VALUES
${body};`;
}

const SLUG_BY_ID = new Map<string, string>(Object.values(events).map((e) => [e.id, e.slug]));

function describeEvents(ids: readonly string[]): string {
  return ids.map((id) => SLUG_BY_ID.get(id) ?? id).join(" + ");
}

export function generateSeedSql(): string {
  return `${[
    HEADER,
    "",
    weddingBlock(),
    "",
    eventsBlock(),
    "",
    familiesBlock(),
    "",
    guestsBlock(),
    "",
    guestEventsBlock(),
  ].join("\n")}\n`;
}

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs");
  const target = new URL("./dev-seed.sql", import.meta.url);
  writeFileSync(target, generateSeedSql());
}
