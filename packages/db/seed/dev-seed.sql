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
-- Events (4) — Sept 2026, Sydney
-- ────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO events (
  id, slug, name, date, location, description,
  start_at, end_at, timezone, address,
  dress_code_description, dress_code_palette,
  pinterest_url, maps_url, sort_order
) VALUES
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000001', 'mehndi', 'Mehndi',
    '2026-09-18', 'The Sharma Residence, Sydney',
    'An intimate evening of music, henna, and family. Traditional dress warmly welcomed.',
    '2026-09-18T16:00:00+10:00', '2026-09-18T22:00:00+10:00', 'Australia/Sydney',
    '12 Banksia Lane, Strathfield NSW 2135',
    'Bright, festive colours encouraged. Traditional or semi-formal Indian attire warmly welcomed.',
    '[{"name":"Marigold","color":"oklch(76.36% 0.1533 75.16)"},{"name":"Fuchsia","color":"oklch(54.66% 0.2139 352.16)"},{"name":"Emerald","color":"oklch(46.05% 0.1156 153.58)"},{"name":"Turquoise","color":"oklch(70.15% 0.1115 186.68)"}]',
    'https://www.pinterest.com/',
    'https://maps.google.com/?q=12+Banksia+Lane+Strathfield+NSW+2135',
    0
  ),
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000002', 'sangeet', 'Sangeet',
    '2026-09-19', 'The Pavilion, Centennial Park, Sydney',
    'An evening of music, dance, and celebration. Bring your dancing shoes!',
    '2026-09-19T18:30:00+10:00', '2026-09-19T23:30:00+10:00', 'Australia/Sydney',
    '1 Grand Drive, Centennial Park NSW 2021',
    'Glamorous and bold — think sequins, rich fabrics, and jewel tones. This is the party night!',
    '[{"name":"Royal Blue","color":"oklch(37.91% 0.1378 265.52)"},{"name":"Gold","color":"oklch(74.99% 0.0854 82.08)"},{"name":"Plum","color":"oklch(38.22% 0.1235 340.14)"},{"name":"Champagne","color":"oklch(93.01% 0.0380 81.51)"}]',
    'https://www.pinterest.com/',
    'https://maps.google.com/?q=The+Pavilion+Centennial+Park+Sydney',
    1
  ),
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000003', 'wedding', 'Wedding Ceremony',
    '2026-09-20', 'Royal Botanic Garden, Sydney',
    'The ceremony will begin at 4 PM. Please be seated by 3:45 PM.',
    '2026-09-20T16:00:00+10:00', '2026-09-20T18:00:00+10:00', 'Australia/Sydney',
    'Mrs Macquaries Road, Sydney NSW 2000',
    'Elegant and formal. Please avoid wearing white or black. Traditional attire from any culture is welcome.',
    '[{"name":"Sage","color":"oklch(72.88% 0.0585 128.92)"},{"name":"Dusty Rose","color":"oklch(78.63% 0.0634 48.93)"},{"name":"Ivory","color":"oklch(99.60% 0.0196 106.75)"},{"name":"Burgundy","color":"oklch(40.08% 0.0948 15.09)"}]',
    'https://www.pinterest.com/',
    'https://maps.google.com/?q=Royal+Botanic+Garden+Sydney',
    2
  ),
  (
    '9f7a2c14-1b3d-4e5f-8a01-000000000004', 'reception', 'Reception',
    '2026-09-20', 'Doltone House, Pyrmont',
    'Dinner and dancing from 7 PM. Cocktail attire.',
    '2026-09-20T19:00:00+10:00', '2026-09-21T00:00:00+10:00', 'Australia/Sydney',
    '26 Pirrama Road, Pyrmont NSW 2009',
    'Cocktail attire — refined and celebratory. Soft metallics and deep jewel tones complement the evening palette.',
    '[{"name":"Midnight","color":"oklch(28.50% 0.0612 268.82)"},{"name":"Copper","color":"oklch(64.20% 0.1082 47.20)"},{"name":"Pearl","color":"oklch(94.80% 0.0148 95.00)"},{"name":"Sapphire","color":"oklch(45.10% 0.1532 252.00)"}]',
    'https://www.pinterest.com/',
    'https://maps.google.com/?q=Doltone+House+Pyrmont',
    3
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
  -- Priya: mehndi + wedding + reception
  ('b0000000-0000-4000-8000-000000000001', '9f7a2c14-1b3d-4e5f-8a01-000000000001'),
  ('b0000000-0000-4000-8000-000000000001', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  ('b0000000-0000-4000-8000-000000000001', '9f7a2c14-1b3d-4e5f-8a01-000000000004'),
  -- James + Emma: wedding + reception
  ('b0000000-0000-4000-8000-000000000002', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  ('b0000000-0000-4000-8000-000000000002', '9f7a2c14-1b3d-4e5f-8a01-000000000004'),
  ('b0000000-0000-4000-8000-000000000003', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  ('b0000000-0000-4000-8000-000000000003', '9f7a2c14-1b3d-4e5f-8a01-000000000004'),
  -- Sophie: wedding only
  ('b0000000-0000-4000-8000-000000000004', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  -- Auntie Meena: mehndi + wedding
  ('b0000000-0000-4000-8000-000000000005', '9f7a2c14-1b3d-4e5f-8a01-000000000001'),
  ('b0000000-0000-4000-8000-000000000005', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  -- Dev Patel: wedding + reception
  ('b0000000-0000-4000-8000-000000000006', '9f7a2c14-1b3d-4e5f-8a01-000000000003'),
  ('b0000000-0000-4000-8000-000000000006', '9f7a2c14-1b3d-4e5f-8a01-000000000004');
