-- Local D1 dev seed for `bun run db:seed`.
--
-- Mirrors apps/api/src/data/{events,guests}.json which the test layer uses
-- via apps/api/src/db/setup.ts#seedDb. Keeping these in sync is currently
-- manual — see wiki/todo/db.md follow-up.
--
-- Idempotent — every INSERT uses `OR IGNORE` so re-running on top of an
-- existing seed is a no-op (PK / unique-index conflicts are skipped). To
-- pick up edits to existing rows, use `bun run db:reset` instead which
-- wipes local D1 state then re-pushes + re-seeds.

-- ────────────────────────────────────────────────────────────────────────────
-- Events (5) — Oct–Nov 2026, Sydney
-- ────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO events (
  id, slug, name, date, location, description,
  start_at, end_at, timezone, address,
  dress_code_description, dress_code_palette,
  pinterest_url, maps_url, sort_order
) VALUES
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000001', 'catholic', 'Catholic Ceremony',
    '2026-10-31', 'Example Parish Hall',
    'Service commences at 10:00am. Free parking onsite.',
    '2026-10-31T10:00:00+11:00', '2026-10-31T13:00:00+11:00', 'Australia/Sydney',
    '123 Example St, Sampletown NSW 2000',
    'Semiformal. Pink and green colour theme.',
    '[{"name":"Blush","color":"oklch(86.50% 0.0480 12.50)"},{"name":"Rose","color":"oklch(64.20% 0.1450 12.00)"},{"name":"Sage","color":"oklch(72.88% 0.0585 128.92)"},{"name":"Emerald","color":"oklch(46.05% 0.1156 153.58)"}]',
    'https://www.pinterest.com.au/example/catholic-wedding-guest-moodboard/',
    'https://maps.google.com/?q=123+Example+St+Sampletown+NSW+2000',
    0
  ),
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000005', 'kitchen-tea', 'Kitchen Tea',
    '2026-11-20', '124 Sample Avenue, Exampleville',
    'From 4pm to 6pm.',
    '2026-11-20T16:00:00+11:00', '2026-11-20T18:00:00+11:00', 'Australia/Sydney',
    '124 Sample Avenue, Exampleville NSW 2001',
    'Smart casual / high tea. Pastel and cream colour theme.',
    '[{"name":"Blush","color":"oklch(86.50% 0.0480 12.50)"},{"name":"Sage","color":"oklch(72.88% 0.0585 128.92)"},{"name":"Cream","color":"oklch(94.80% 0.0250 90.00)"},{"name":"Dusty Rose","color":"oklch(78.63% 0.0634 48.93)"}]',
    'https://www.pinterest.com.au/example/kitchen-tea-mood-board/',
    'https://maps.google.com/?q=124+Sample+Avenue+Exampleville+NSW+2001',
    1
  ),
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000002', 'mehendi', 'Mehendi',
    '2026-11-22', '124 Sample Avenue, Exampleville',
    'From 6pm.',
    '2026-11-22T18:00:00+11:00', '2026-11-22T23:00:00+11:00', 'Australia/Sydney',
    '124 Sample Avenue, Exampleville NSW 2001',
    'Semicasual/Indian. Yellow and orange colour theme.',
    '[{"name":"Marigold","color":"oklch(76.36% 0.1533 75.16)"},{"name":"Saffron","color":"oklch(72.50% 0.1700 60.00)"},{"name":"Amber","color":"oklch(80.00% 0.1450 85.00)"},{"name":"Burnt Orange","color":"oklch(58.50% 0.1620 42.00)"}]',
    'https://www.pinterest.com.au/example/mehendi-moodboard/',
    'https://maps.google.com/?q=124+Sample+Avenue+Exampleville+NSW+2001',
    2
  ),
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000003', 'hindu', 'Hindu Ceremony',
    '2026-11-25', 'Example Temple',
    'Service commences at 9am. Free parking onsite and adjacent streets (some streets may be time limited).',
    '2026-11-25T09:00:00+11:00', '2026-11-25T12:00:00+11:00', 'Australia/Sydney',
    '125 Placeholder Highway, Mocktown NSW 2002',
    'Formal/Indian Traditional. Earth tones colour theme.',
    '[{"name":"Terracotta","color":"oklch(58.20% 0.1240 38.50)"},{"name":"Ochre","color":"oklch(70.50% 0.1180 75.00)"},{"name":"Olive","color":"oklch(55.00% 0.0720 110.00)"},{"name":"Sand","color":"oklch(82.00% 0.0480 80.00)"}]',
    'https://www.pinterest.com.au/example/hindu-wedding-guest-moodboard/',
    'https://maps.google.com/?q=125+Placeholder+Highway+Mocktown+NSW+2002',
    3
  ),
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000004', 'reception', 'Reception',
    '2026-11-28', 'Sample Reception House',
    'From 6pm. Free parking onsite.',
    '2026-11-28T18:00:00+11:00', '2026-11-28T23:00:00+11:00', 'Australia/Sydney',
    '126 Example Road, Testburg NSW 2003',
    'Formal. Dark blue and dark purple colour theme.',
    '[{"name":"Midnight","color":"oklch(28.50% 0.0612 268.82)"},{"name":"Sapphire","color":"oklch(40.00% 0.1450 252.00)"},{"name":"Indigo","color":"oklch(35.00% 0.1320 290.00)"},{"name":"Plum","color":"oklch(38.22% 0.1235 340.14)"}]',
    'https://www.pinterest.com.au/example/reception-guest-moodboard/',
    'https://maps.google.com/?q=126+Example+Road+Testburg+NSW+2003',
    4
  );

-- ────────────────────────────────────────────────────────────────────────────
-- Families (4) — stable UUIDs so dev links don't drift between seeds
-- ────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO families (id, public_id, family_name, created_at, updated_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'SHARMA-IVY-QM42', 'Sharma',  unixepoch() * 1000, unixepoch() * 1000),
  ('a0000000-0000-4000-8000-000000000002', 'WILSON-OAK-7R2P', 'Wilson',  unixepoch() * 1000, unixepoch() * 1000),
  ('a0000000-0000-4000-8000-000000000003', 'MEENA-DEW-K9X3',  'Meena',   unixepoch() * 1000, unixepoch() * 1000),
  ('a0000000-0000-4000-8000-000000000004', 'PATEL-JOY-RK97',  'Patel',   unixepoch() * 1000, unixepoch() * 1000);

-- ────────────────────────────────────────────────────────────────────────────
-- Guests (6)
-- ────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO guests (id, family_id, first_name, last_name, sort_order, created_at, updated_at) VALUES
  -- Sharma
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Priya',  'Sharma', 0, unixepoch() * 1000, unixepoch() * 1000),
  -- Wilson
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'James',  'Wilson', 0, unixepoch() * 1000, unixepoch() * 1000),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002', 'Emma',   'Wilson', 1, unixepoch() * 1000, unixepoch() * 1000),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002', 'Sophie', 'Wilson', 2, unixepoch() * 1000, unixepoch() * 1000),
  -- Meena
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000003', 'Auntie', 'Meena',  0, unixepoch() * 1000, unixepoch() * 1000),
  -- Patel
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000004', 'Dev',    'Patel',  0, unixepoch() * 1000, unixepoch() * 1000);

-- ────────────────────────────────────────────────────────────────────────────
-- Event invitations
-- ────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO guest_events (guest_id, event_id) VALUES
  -- Priya: catholic + hindu + reception
  ('b0000000-0000-4000-8000-000000000001', '9f7a2c14-1b3d-4e5f-8a01-000000000001'),
  ('b0000000-0000-4000-8000-000000000001', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  ('b0000000-0000-4000-8000-000000000001', '9f7a2c14-1b3d-4e5f-8a01-000000000004'),
  -- James + Emma: hindu + reception
  ('b0000000-0000-4000-8000-000000000002', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  ('b0000000-0000-4000-8000-000000000002', '9f7a2c14-1b3d-4e5f-8a01-000000000004'),
  ('b0000000-0000-4000-8000-000000000003', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  ('b0000000-0000-4000-8000-000000000003', '9f7a2c14-1b3d-4e5f-8a01-000000000004'),
  -- Sophie: hindu only
  ('b0000000-0000-4000-8000-000000000004', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  -- Auntie Meena: catholic + hindu
  ('b0000000-0000-4000-8000-000000000005', '9f7a2c14-1b3d-4e5f-8a01-000000000001'),
  ('b0000000-0000-4000-8000-000000000005', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  -- Dev Patel: all five (default demo code — exercises every event)
  ('b0000000-0000-4000-8000-000000000006', '9f7a2c14-1b3d-4e5f-8a01-000000000001'),
  ('b0000000-0000-4000-8000-000000000006', '9f7a2c14-1b3d-4e5f-8a01-000000000002'),
  ('b0000000-0000-4000-8000-000000000006', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  ('b0000000-0000-4000-8000-000000000006', '9f7a2c14-1b3d-4e5f-8a01-000000000004'),
  ('b0000000-0000-4000-8000-000000000006', '9f7a2c14-1b3d-4e5f-8a01-000000000005');
