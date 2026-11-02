-- The envelope a wedding's guests open before the invite.
--
-- `wedding_invite_customisations` gains `envelope_id`, an id from the
-- `@cire/envelope` catalog. Nullable with no default: NULL is no envelope,
-- which every wedding has until its organiser picks one, so no back-fill.
--
-- Additive: ALTER TABLE ADD, never a rebuild. The statement is drizzle-kit's,
-- as `db:generate` wrote it; it matches cire/db/src/schema.ts and
-- cire/api/src/db/setup.ts (`ddl-lockstep.test.ts`).
ALTER TABLE `wedding_invite_customisations` ADD `envelope_id` text;