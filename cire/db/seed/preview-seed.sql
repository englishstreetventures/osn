-- Seed for the PREVIEW tier (`cire-db-preview`), applied by
-- `.github/workflows/deploy-cire-preview.yml` on every preview deploy.
--
-- Three sample weddings, identical in content and differing ONLY in their
-- colour scheme, so the preview opens on something worth looking at and the
-- schemes can be compared side by side rather than one at a time.
--
-- NEVER run this against `cire-db`. It is scoped to the disposable preview
-- database and owned by the fixed dev profile id, not a real organiser.
--
-- Idempotent: content rows use `INSERT OR IGNORE` (re-running is a no-op), and
-- the customisation rows use `INSERT OR REPLACE` so an edited scheme here
-- actually lands on the next push instead of being silently skipped.

-- ────────────────────────────────────────────────────────────────────────────
-- Weddings — one per scheme
-- ────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO weddings (id, slug, display_name, owner_osn_profile_id, code_style, created_at, updated_at) VALUES
  ('wed_preview_evergreen', 'preview-evergreen', 'Preview — Evergreen', 'usr_dev_bootstrap_owner', 'secure', unixepoch(), unixepoch()),
  ('wed_preview_chapel',    'preview-chapel',    'Preview — Chapel',    'usr_dev_bootstrap_owner', 'secure', unixepoch(), unixepoch()),
  ('wed_preview_jewel',     'preview-jewel',     'Preview — Jewel',     'usr_dev_bootstrap_owner', 'secure', unixepoch(), unixepoch());

-- ────────────────────────────────────────────────────────────────────────────
-- Colour schemes
-- ────────────────────────────────────────────────────────────────────────────
--
-- `evergreen` leaves every seed NULL: that is the built-in look, and it is the
-- control — if it ever stops matching production, the derivation has drifted.
-- The other two carry their preset key only, so they follow `PALETTE_PRESETS`
-- in `@cire/theme` rather than freezing a copy of the hexes here.
--
-- Tones give the page its rhythm: story on a card, events raised (jewel) or on a
-- card (chapel), so the three surfaces are all visible on one scroll.

INSERT OR REPLACE INTO wedding_invite_customisations (
  wedding_id, hero_title, hero_subtitle,
  story_eyebrow, story_heading, story_body,
  details_eyebrow, details_heading, welcome_message,
  palette_preset, hero_tone, story_tone, details_tone, welcome_tone,
  hero_blur, hero_title_backdrop_opacity, hero_title_backdrop_blur,
  updated_at
) VALUES
  (
    'wed_preview_evergreen', 'Anita & Ben', 'Two days in Goa',
    'Our Story', 'How It All Began',
    'We met on a rainy Tuesday and have been arguing about the best route home ever since. This is the built-in scheme — it should look exactly like production.',
    'Celebrate With Us', 'Your Events', 'So glad you can join us.',
    NULL, NULL, 'card', 'card', NULL,
    28, 40, 6, unixepoch()
  ),
  (
    'wed_preview_chapel', 'Anita & Ben', 'Two days in Goa',
    'Our Story', 'How It All Began',
    'The same invite on a light scheme — candle-cream page, brass accent, sage highlight. Every border, button and pop-up follows the five colours.',
    'Celebrate With Us', 'Your Events', 'So glad you can join us.',
    'chapel', NULL, 'card', 'card', NULL,
    28, 40, 6, unixepoch()
  ),
  (
    'wed_preview_jewel', 'Anita & Ben', 'Two days in Goa',
    'Our Story', 'How It All Began',
    'The same invite again, ceremonial and dark — aubergine night, gold, marigold. Note the events section sits on the raised surface.',
    'Celebrate With Us', 'Your Events', 'So glad you can join us.',
    'jewel', NULL, 'card', 'raised', NULL,
    28, 40, 6, unixepoch()
  );

-- ────────────────────────────────────────────────────────────────────────────
-- Events — two per wedding, one with a dress-code palette
-- ────────────────────────────────────────────────────────────────────────────
--
-- The dress-code swatches are deliberately the SAME literal colours on all
-- three: they describe what guests should wear, so they must NOT follow the
-- invite's scheme. Comparing the three previews is the quickest way to confirm
-- that still holds.
--
-- NOTE `events.slug` is UNIQUE ACROSS ALL WEDDINGS (`events_slug_unique`), not
-- per wedding — so the three ceremonies need distinct slugs or two of the three
-- rows are silently dropped by `OR IGNORE` and their guest_events fail the FK.

INSERT OR IGNORE INTO events (
  id, wedding_id, slug, name, description,
  start_at, end_at, timezone, address,
  dress_code_description, dress_code_palette, sort_order
) VALUES
  ('e0000000-0000-4000-8000-00000000ev01', 'wed_preview_evergreen', 'evergreen-ceremony', 'Ceremony',
   'Service commences at 10:00am. Free parking onsite.',
   '2026-10-31T10:00:00+11:00', '2026-10-31T13:00:00+11:00', 'Australia/Sydney',
   '123 Example St, Sampletown NSW 2000',
   'Semiformal. Pink and green colour theme.',
   '[{"name":"Blush","color":"oklch(86.50% 0.0480 12.50)"},{"name":"Sage","color":"oklch(72.88% 0.0585 128.92)"}]', 0),
  ('e0000000-0000-4000-8000-00000000ev02', 'wed_preview_evergreen', 'evergreen-reception', 'Reception',
   'Dinner and dancing from 6pm.',
   '2026-10-31T18:00:00+11:00', '2026-10-31T23:30:00+11:00', 'Australia/Sydney',
   '126 Example Road, Testburg NSW 2003', 'Formal.', NULL, 1),

  ('e0000000-0000-4000-8000-00000000ch01', 'wed_preview_chapel', 'chapel-ceremony', 'Ceremony',
   'Service commences at 10:00am. Free parking onsite.',
   '2026-10-31T10:00:00+11:00', '2026-10-31T13:00:00+11:00', 'Australia/Sydney',
   '123 Example St, Sampletown NSW 2000',
   'Semiformal. Pink and green colour theme.',
   '[{"name":"Blush","color":"oklch(86.50% 0.0480 12.50)"},{"name":"Sage","color":"oklch(72.88% 0.0585 128.92)"}]', 0),
  ('e0000000-0000-4000-8000-00000000ch02', 'wed_preview_chapel', 'chapel-reception', 'Reception',
   'Dinner and dancing from 6pm.',
   '2026-10-31T18:00:00+11:00', '2026-10-31T23:30:00+11:00', 'Australia/Sydney',
   '126 Example Road, Testburg NSW 2003', 'Formal.', NULL, 1),

  ('e0000000-0000-4000-8000-00000000jw01', 'wed_preview_jewel', 'jewel-ceremony', 'Ceremony',
   'Service commences at 10:00am. Free parking onsite.',
   '2026-10-31T10:00:00+11:00', '2026-10-31T13:00:00+11:00', 'Australia/Sydney',
   '123 Example St, Sampletown NSW 2000',
   'Semiformal. Pink and green colour theme.',
   '[{"name":"Blush","color":"oklch(86.50% 0.0480 12.50)"},{"name":"Sage","color":"oklch(72.88% 0.0585 128.92)"}]', 0),
  ('e0000000-0000-4000-8000-00000000jw02', 'wed_preview_jewel', 'jewel-reception', 'Reception',
   'Dinner and dancing from 6pm.',
   '2026-10-31T18:00:00+11:00', '2026-10-31T23:30:00+11:00', 'Australia/Sydney',
   '126 Example Road, Testburg NSW 2003', 'Formal.', NULL, 1);

-- ────────────────────────────────────────────────────────────────────────────
-- One family per wedding, so the events can actually be unlocked
-- ────────────────────────────────────────────────────────────────────────────
--
-- The code is the same shape as a real one and is printed in the PR body. It
-- guards nothing but sample data on a disposable database.

INSERT OR IGNORE INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES
  ('f0000000-0000-4000-8000-00000000ev01', 'wed_preview_evergreen', 'PREVIEW-EVERGREEN-0001', 'Testfamily', unixepoch() * 1000, unixepoch() * 1000),
  ('f0000000-0000-4000-8000-00000000ch01', 'wed_preview_chapel',    'PREVIEW-CHAPEL-0002',    'Testfamily', unixepoch() * 1000, unixepoch() * 1000),
  ('f0000000-0000-4000-8000-00000000jw01', 'wed_preview_jewel',     'PREVIEW-JEWEL-0003',     'Testfamily', unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO guests (id, family_id, first_name, last_name, sort_order, created_at, updated_at) VALUES
  ('g0000000-0000-4000-8000-00000000ev01', 'f0000000-0000-4000-8000-00000000ev01', 'Ada', 'Testfamily', 0, unixepoch() * 1000, unixepoch() * 1000),
  ('g0000000-0000-4000-8000-00000000ev02', 'f0000000-0000-4000-8000-00000000ev01', 'Bo',  'Testfamily', 1, unixepoch() * 1000, unixepoch() * 1000),
  ('g0000000-0000-4000-8000-00000000ch01', 'f0000000-0000-4000-8000-00000000ch01', 'Ada', 'Testfamily', 0, unixepoch() * 1000, unixepoch() * 1000),
  ('g0000000-0000-4000-8000-00000000ch02', 'f0000000-0000-4000-8000-00000000ch01', 'Bo',  'Testfamily', 1, unixepoch() * 1000, unixepoch() * 1000),
  ('g0000000-0000-4000-8000-00000000jw01', 'f0000000-0000-4000-8000-00000000jw01', 'Ada', 'Testfamily', 0, unixepoch() * 1000, unixepoch() * 1000),
  ('g0000000-0000-4000-8000-00000000jw02', 'f0000000-0000-4000-8000-00000000jw01', 'Bo',  'Testfamily', 1, unixepoch() * 1000, unixepoch() * 1000);

INSERT OR IGNORE INTO guest_events (guest_id, event_id) VALUES
  ('g0000000-0000-4000-8000-00000000ev01', 'e0000000-0000-4000-8000-00000000ev01'),
  ('g0000000-0000-4000-8000-00000000ev01', 'e0000000-0000-4000-8000-00000000ev02'),
  ('g0000000-0000-4000-8000-00000000ev02', 'e0000000-0000-4000-8000-00000000ev02'),
  ('g0000000-0000-4000-8000-00000000ch01', 'e0000000-0000-4000-8000-00000000ch01'),
  ('g0000000-0000-4000-8000-00000000ch01', 'e0000000-0000-4000-8000-00000000ch02'),
  ('g0000000-0000-4000-8000-00000000ch02', 'e0000000-0000-4000-8000-00000000ch02'),
  ('g0000000-0000-4000-8000-00000000jw01', 'e0000000-0000-4000-8000-00000000jw01'),
  ('g0000000-0000-4000-8000-00000000jw01', 'e0000000-0000-4000-8000-00000000jw02'),
  ('g0000000-0000-4000-8000-00000000jw02', 'e0000000-0000-4000-8000-00000000jw02');
