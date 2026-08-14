// Derives seed/dev-seed.sql from the canonical seed data in ./data, and
// seed/dev-reset.sql from the Drizzle schema. Run with
// `bun run --cwd cire/db seed:generate` after editing anything under ./data or
// adding a table to src/schema.ts — both files are generated, never hand-edited.
// seed.test.ts fails CI if either committed file drifts from what this emits.
//
//   bun run --cwd cire/db seed:generate         # regenerate both files
//
// The output is byte-for-byte deterministic so the in-repo files are a pure
// function of ./data + src/schema.ts.

import { getTableName, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "../src/schema";
import {
  bootstrapWedding,
  customisation,
  DEV_OWNER_PROFILE_ID,
  DIETARY_CONSENT_VERSION,
  entitlements,
  events,
  guests,
  hosts,
  rsvps,
  syntheticFamilies,
  syntheticRsvps,
  type SeedFamily,
  type SeedRsvp,
} from "./data";

// SQL single-quote escaping: double any embedded apostrophe.
const sql = (value: string): string => `'${value.replaceAll("'", "''")}'`;

// A reply's `created_at` (and its consent stamp) as an offset from seed time, so
// seeded replies always read as recent however long ago the seed was written.
const daysAgo = (n: number): string => `unixepoch() - ${86_400 * n}`;

// D1 rejects very large statements, and a single INSERT carrying every synthetic
// row would be one. Rows per INSERT for the synthetic blocks.
const CHUNK = 200;

const HEADER = `-- Local D1 dev seed for \`bun run db:seed\`.
--
-- GENERATED FILE — do not edit by hand. Regenerate with:
--   bun run --cwd cire/db seed:generate
-- The single source of truth is cire/db/seed/data/ (wedding.ts, events.ts,
-- guests.ts, customisations.ts, hosts.ts, entitlements.ts, rsvps.ts and the
-- synthetic households in households.ts). cire/api/src/db/setup.ts#seedDb reads
-- the first three, so the test fixtures and this SQL can no longer drift.
-- seed.test.ts fails CI on drift.
--
-- Idempotent — every INSERT uses \`OR IGNORE\` so re-running on top of an
-- existing seed is a no-op (PK / unique-index conflicts are skipped). To
-- pick up edits to existing rows, use \`bun run db:reset\` instead which
-- wipes local D1 state then re-pushes + re-seeds.`;

const RULE = "-- ────────────────────────────────────────────────────────────────────────────";

function section(title: string, body: string): string {
  return `${RULE}
-- ${title}
${RULE}

${body}`;
}

// Splits `rows` across as many INSERT statements as it takes to keep each one
// under CHUNK value rows.
function chunkedInsert(table: string, columns: string, rows: readonly string[]): string {
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    statements.push(
      `INSERT OR IGNORE INTO ${table} (\n  ${columns}\n) VALUES\n${rows.slice(i, i + CHUNK).join(",\n")};`,
    );
  }
  return statements.join("\n\n");
}

function weddingBlock(): string {
  return section(
    "Sample wedding (local dev only)",
    `-- Migration 0006 seeded \`wed_bootstrap\`, but migration 0015 deletes it (prod
-- starts clean — every real OSN user creates their own weddings). So the local
-- dev seed now owns its sample wedding row outright instead of relying on the
-- migration's seeded row. Owned by the fixed dev id \`${bootstrapWedding.ownerOsnProfileId}\`
-- (DEV_OWNER_PROFILE_ID in cire/db/seed/data/wedding.ts) so a signed-in dev
-- account can own it; override the owner after seeding via
-- CIRE_DEV_OWNER_PROFILE_ID (see scripts/cire-db-seed.sh). The events/families
-- below are FK-scoped to it.
--
-- The profile columns (date, guest estimate, currency, budget, RSVP deadline)
-- are set rather than left NULL: an organiser fills them in early, and every
-- planning surface reads as "not started" without them.
INSERT OR IGNORE INTO weddings (
  id, slug, display_name, owner_osn_profile_id, code_style,
  wedding_date, guest_count_estimate, currency, budget_total_minor,
  rsvp_deadline, rsvp_deadline_timezone,
  created_at, updated_at
) VALUES (
  ${sql(bootstrapWedding.id)}, ${sql(bootstrapWedding.slug)}, ${sql(bootstrapWedding.displayName)}, ${sql(bootstrapWedding.ownerOsnProfileId)}, ${sql(bootstrapWedding.codeStyle)},
  ${sql(bootstrapWedding.weddingDate)}, ${bootstrapWedding.guestCountEstimate}, ${sql(bootstrapWedding.currency)}, ${bootstrapWedding.budgetTotalMinor},
  ${sql(bootstrapWedding.rsvpDeadline)}, ${sql(bootstrapWedding.rsvpDeadlineTimezone)},
  unixepoch(), unixepoch()
);`,
  );
}

function eventsBlock(): string {
  const rows = Object.values(events).map((event) => {
    const palette = JSON.stringify(
      event.dressCodePalette.map((swatch) => ({ name: swatch.name, color: swatch.color })),
    );
    return `  (
    ${sql(event.id)}, ${sql(bootstrapWedding.id)}, ${sql(event.slug)}, ${sql(event.name)},
    ${sql(event.description)},
    ${sql(event.startAt)}, ${sql(event.endAt)}, ${sql(event.timezone)},
    ${sql(event.address)},
    ${sql(event.dressCodeDescription)},
    ${sql(palette)},
    ${sql(event.pinterestUrl)},
    ${sql(event.mapsUrl)},
    ${event.sortOrder},
    ${sql(event.eventImageKey)},
    ${sql(JSON.stringify(event.eventImageCrop))},
    unixepoch(), unixepoch()
  )`;
  });

  return section(
    `Events (${rows.length}) — Oct–Nov 2026, Sydney`,
    `-- All events/families are scoped to the sample wedding above (\`${bootstrapWedding.id}\`).
-- The wedding_id column is NOT NULL with an FK, so the seed supplies it
-- explicitly.
--
-- \`event_image_key\` is an R2 object KEY, not a URL. The bytes must exist in the
-- tier's bucket or the card renders a broken image — upload them once with
-- \`bun run --cwd cire/db assets:seed:dev\`.
INSERT OR IGNORE INTO events (
  id, wedding_id, slug, name, description,
  start_at, end_at, timezone, address,
  dress_code_description, dress_code_palette,
  pinterest_url, maps_url, sort_order,
  event_image_key, event_image_crop,
  created_at, updated_at
) VALUES
${rows.join(",\n")};`,
  );
}

function customisationBlock(): string {
  const c = customisation;
  return section(
    "Invite customisation — copy, images, palette, typography",
    `-- One row per wedding (wedding_id is the primary key). Without it the guest
-- site falls back to placeholder copy and renders no images, which is what a
-- wedding looks like in the first ten minutes and never again.
INSERT OR IGNORE INTO wedding_invite_customisations (
  wedding_id,
  hero_title, hero_subtitle,
  story_eyebrow, story_heading, story_body,
  details_eyebrow, details_heading,
  welcome_message, footer_message,
  hero_image_key, story_image_key, footer_image_key,
  hero_image_crop, hero_image_crop_mobile, story_image_crop, footer_image_crop,
  hero_blur, hero_title_backdrop_opacity, hero_title_backdrop_blur,
  theme_heading_font, theme_body_font, theme_heading_size,
  theme_heading_weight, theme_heading_style, theme_body_weight, theme_body_style,
  palette_preset, palette_ground, palette_card, palette_ink, palette_gilt, palette_bloom,
  hero_tone, story_tone, details_tone, welcome_tone,
  invite_message, design_id,
  updated_at, images_updated_at
) VALUES (
  ${sql(bootstrapWedding.id)},
  ${sql(c.heroTitle)}, ${sql(c.heroSubtitle)},
  ${sql(c.storyEyebrow)}, ${sql(c.storyHeading)},
  ${sql(c.storyBody)},
  ${sql(c.detailsEyebrow)}, ${sql(c.detailsHeading)},
  ${sql(c.welcomeMessage)},
  ${sql(c.footerMessage)},
  ${sql(c.heroImageKey)}, ${sql(c.storyImageKey)}, ${sql(c.footerImageKey)},
  ${sql(JSON.stringify(c.heroImageCrop))}, ${sql(JSON.stringify(c.heroImageCropMobile))}, ${sql(JSON.stringify(c.storyImageCrop))}, ${sql(JSON.stringify(c.footerImageCrop))},
  ${c.heroBlur}, ${c.heroTitleBackdropOpacity}, ${c.heroTitleBackdropBlur},
  ${sql(c.themeHeadingFont)}, ${sql(c.themeBodyFont)}, ${sql(c.themeHeadingSize)},
  ${sql(c.themeHeadingWeight)}, ${sql(c.themeHeadingStyle)}, ${sql(c.themeBodyWeight)}, ${sql(c.themeBodyStyle)},
  ${sql(c.palettePreset)}, ${sql(c.paletteGround)}, ${sql(c.paletteCard)}, ${sql(c.paletteInk)}, ${sql(c.paletteGilt)}, ${sql(c.paletteBloom)},
  ${sql(c.heroTone)}, ${sql(c.storyTone)}, ${sql(c.detailsTone)}, ${sql(c.welcomeTone)},
  ${sql(c.inviteMessage)}, ${sql(c.designId)},
  unixepoch(), unixepoch()
);`,
  );
}

function hostsBlock(): string {
  const rows = hosts.map(
    (host) =>
      `  (${sql(host.id)}, ${sql(bootstrapWedding.id)}, ${sql(host.osnProfileId)}, ${sql(DEV_OWNER_PROFILE_ID)}, ${sql(host.role)}, unixepoch())`,
  );
  return section(
    `Co-hosts (${rows.length})`,
    `-- The OWNER is not in this table — ownership lives in
-- weddings.owner_osn_profile_id. These are the people the owner shared the
-- wedding with, all added BY the owner.
INSERT OR IGNORE INTO wedding_hosts (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, created_at) VALUES
${rows.join(",\n")};`,
  );
}

function entitlementsBlock(): string {
  const rows = entitlements.map(
    (e) =>
      `  (${sql(bootstrapWedding.id)}, ${sql(e.entitlement)}, ${sql(e.source)}, unixepoch(), ${sql(e.grantedBy)}, NULL)`,
  );
  return section(
    `Entitlements (${rows.length})`,
    `-- All \`comp\`: no payment provider is wired up on a dev tier, and without
-- these the premium surfaces (vendors, AI, the 1000-guest cap) never render.
INSERT OR IGNORE INTO wedding_entitlements (wedding_id, entitlement, source, granted_at, granted_by, provider_ref) VALUES
${rows.join(",\n")};`,
  );
}

function familyRow(family: SeedFamily): string {
  return `  (${sql(family.id)}, ${sql(bootstrapWedding.id)}, ${sql(family.publicId)}, ${sql(family.familyName)}, unixepoch(), unixepoch())`;
}

const FAMILY_COLUMNS = "id, wedding_id, public_id, family_name, created_at, updated_at";
const GUEST_COLUMNS = "id, family_id, first_name, last_name, sort_order, created_at, updated_at";
const RSVP_COLUMNS =
  "id, guest_id, event_id, status, dietary, dietary_consent_at, dietary_consent_version, consent_source, created_at";

function familiesBlock(): string {
  const rows = guests.map(familyRow);
  return section(
    `Families (${rows.length}) — stable UUIDs so dev links don't drift between seeds`,
    `INSERT OR IGNORE INTO families (${FAMILY_COLUMNS}) VALUES
${rows.join(",\n")};`,
  );
}

function guestsBlock(): string {
  const rows: string[] = [];
  for (const family of guests) {
    rows.push(`  -- ${family.familyName}`);
    family.guests.forEach((guest, index) => {
      rows.push(
        `  (${sql(guest.id)}, ${sql(family.id)}, ${sql(guest.firstName)}, ${sql(guest.lastName)}, ${index}, unixepoch(), unixepoch())`,
      );
    });
  }
  // Re-join with commas only between the value rows (comment lines are not
  // value rows). We render the value rows comma-separated and append the
  // trailing semicolon; comment lines sit on their own line.
  const total = guests.reduce((n, f) => n + f.guests.length, 0);
  const body = renderCommentedValueRows(rows);
  return section(
    `Guests (${total})`,
    `INSERT OR IGNORE INTO guests (${GUEST_COLUMNS}) VALUES
${body};`,
  );
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
  return section(
    "Event invitations",
    `INSERT OR IGNORE INTO guest_events (guest_id, event_id) VALUES
${body};`,
  );
}

function rsvpRow(rsvp: SeedRsvp): string {
  // Consent is stamped iff there is dietary text — Art. 9(2)(a) consent
  // authorises exactly that free-text, so a reply with none has nothing to
  // consent to. Same rule the live write path applies
  // (cire/api/src/services/rsvp.ts).
  const consentAt = rsvp.dietary === "" ? "NULL" : daysAgo(rsvp.daysAgo);
  const consentVersion = rsvp.dietary === "" ? "NULL" : sql(DIETARY_CONSENT_VERSION);
  return `  (${sql(rsvp.id)}, ${sql(rsvp.guestId)}, ${sql(rsvp.eventId)}, ${sql(rsvp.status)}, ${sql(rsvp.dietary)}, ${consentAt}, ${consentVersion}, ${sql(rsvp.consentSource)}, ${daysAgo(rsvp.daysAgo)})`;
}

function rsvpsBlock(): string {
  const rows = rsvps.map(rsvpRow);
  return section(
    `Replies (${rows.length}) — the canonical families`,
    `-- Covers every axis the read paths branch on: all three statuses, dietary text
-- present and absent, and both consent sources. The Placeholder family
-- (TESTFOR-JOY-DD44) is deliberately left reply-free — it is the manual smoke-test
-- code, so its invite must still open on a blank RSVP form.
INSERT OR IGNORE INTO rsvps (${RSVP_COLUMNS}) VALUES
${rows.join(",\n")};`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic households — production scale
// ─────────────────────────────────────────────────────────────────────────────

function syntheticFamiliesBlock(): string {
  const rows = syntheticFamilies.map(familyRow);
  return section(
    `Synthetic households (${rows.length}) — brings the list to production scale`,
    `-- Invented people, generated deterministically by cire/db/seed/data/households.ts.
-- Not one row is derived from a real guest list. They exist because the four
-- canonical families are six guests between them, and at six guests every
-- pagination, export, summary and N+1 query looks fine.
${chunkedInsert("families", FAMILY_COLUMNS, rows)}`,
  );
}

function syntheticGuestsBlock(): string {
  const rows: string[] = [];
  for (const family of syntheticFamilies) {
    family.guests.forEach((guest, index) => {
      rows.push(
        `  (${sql(guest.id)}, ${sql(family.id)}, ${sql(guest.firstName)}, ${sql(guest.lastName)}, ${index}, unixepoch(), unixepoch())`,
      );
    });
  }
  return section(`Synthetic guests (${rows.length})`, chunkedInsert("guests", GUEST_COLUMNS, rows));
}

function syntheticGuestEventsBlock(): string {
  const rows: string[] = [];
  for (const family of syntheticFamilies) {
    for (const guest of family.guests) {
      for (const eventId of guest.events) {
        rows.push(`  (${sql(guest.id)}, ${sql(eventId)})`);
      }
    }
  }
  return section(
    `Synthetic invitations (${rows.length})`,
    chunkedInsert("guest_events", "guest_id, event_id", rows),
  );
}

function syntheticRsvpsBlock(): string {
  const rows = syntheticRsvps.map(rsvpRow);
  return section(
    `Synthetic replies (${rows.length})`,
    `-- Roughly one household in seven has replied, which is where the live wedding
-- sits. The rest are outstanding, so every "who hasn't replied" surface has
-- something real to page through.
${chunkedInsert("rsvps", RSVP_COLUMNS, rows)}`,
  );
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
    customisationBlock(),
    "",
    hostsBlock(),
    "",
    entitlementsBlock(),
    "",
    familiesBlock(),
    "",
    guestsBlock(),
    "",
    guestEventsBlock(),
    "",
    rsvpsBlock(),
    "",
    syntheticFamiliesBlock(),
    "",
    syntheticGuestsBlock(),
    "",
    syntheticGuestEventsBlock(),
    "",
    syntheticRsvpsBlock(),
  ].join("\n")}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// dev-reset.sql — wipe a disposable database back to empty
// ─────────────────────────────────────────────────────────────────────────────

// Every table Drizzle declares in src/schema.ts, sorted so the output is stable.
// Read from the schema rather than a hand-kept list: a new table added without a
// matching DROP would survive the reset, and the next migration replay would die
// on `CREATE TABLE` — a green deploy that quietly stopped resetting is worse.
// Drop order matters, and `PRAGMA defer_foreign_keys` does not save us: wrangler
// sends a --file as separate statements, so the pragma is gone by the next one.
// With foreign keys on, dropping a parent first makes the later drop of its child
// fail — SQLite runs an implicit DELETE on the child and cannot find the parent it
// must check ("no such table: main.events"). So children go first: a table is
// dropped before anything it points at.
//
// Depth is the longest chain of references out of a table. Dropping deepest-first
// puts every child ahead of its parent. Self-references and cycles are skipped by
// the in-progress set, which cannot loop.
function referenceDepth(
  table: SQLiteTable,
  byName: ReadonlyMap<string, SQLiteTable>,
  cache: Map<string, number>,
  inProgress: ReadonlySet<string>,
): number {
  const name = getTableName(table);
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const walking = new Set(inProgress).add(name);
  let depth = 0;
  for (const fk of getTableConfig(table).foreignKeys) {
    const parentName = getTableName(fk.reference().foreignTable);
    if (walking.has(parentName)) continue;
    const parent = byName.get(parentName);
    if (parent === undefined) continue;
    depth = Math.max(depth, 1 + referenceDepth(parent, byName, cache, walking));
  }

  cache.set(name, depth);
  return depth;
}

export function schemaTableNames(): readonly string[] {
  const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));
  const byName = new Map(tables.map((table) => [getTableName(table), table] as const));
  const cache = new Map<string, number>();
  const depths = new Map(
    tables.map(
      (table) => [getTableName(table), referenceDepth(table, byName, cache, new Set())] as const,
    ),
  );

  // Deepest first, then alphabetical — so the file is stable whatever order
  // schema.ts happens to export in.
  const names = [...depths.keys()].toSorted(
    (a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0) || a.localeCompare(b),
  );

  // A reflection walk that returns nothing looks exactly like a schema with no
  // tables, and both regenerate green: seed.test.ts would compare an empty
  // committed file against an empty generated one and agree. The deploy would
  // then stop resetting silently, which is the failure this file exists to
  // prevent. cire has had tables since 0001 and will never have none.
  if (names.length === 0) {
    throw new Error(
      "cire/db/src/schema.ts exported no SQLiteTable — refusing to emit a reset that drops nothing.",
    );
  }

  return names;
}

export function generateResetSql(): string {
  const drops = [
    // wrangler's own migration ledger. Dropping it is the point: the dev deploy
    // then replays every migration from 0001 against an empty database, so each
    // deploy doubles as a migration test. Leave it and `d1 migrations apply`
    // believes the (now missing) tables are already there.
    "d1_migrations",
    ...schemaTableNames(),
  ];

  return `-- Wipes a cire D1 back to empty. GENERATED FILE — do not edit by hand.
-- Regenerate with: bun run --cwd cire/db seed:generate
-- The table list is read from cire/db/src/schema.ts; seed.test.ts fails CI on drift.
--
-- DESTRUCTIVE. Only ever run against a disposable database. The dev deploy runs
-- it on every merge (reset -> migrate -> seed), and scripts/cire-db-seed.sh
-- refuses any remote target whose name is not \`cire-db-dev\`.
--
-- Tables are dropped children first (deepest reference chain first). wrangler
-- sends a --file as separate statements, so a PRAGMA cannot hold foreign keys off
-- across the batch: drop a parent early and the child's own drop fails.

${drops.map((name) => `DROP TABLE IF EXISTS ${name};`).join("\n")}
`;
}

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("./dev-seed.sql", import.meta.url), generateSeedSql());
  writeFileSync(new URL("./dev-reset.sql", import.meta.url), generateResetSql());
}
