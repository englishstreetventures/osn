-- Ends every ordinary session of an account that holds no passkey.
--
-- From this release a sign-up's session stays restricted until the new
-- account's first passkey is in, so no new account gets an ordinary session
-- without one. Accounts made before it that never added a passkey may still
-- hold an ordinary, sliding session, which would let /authorize sign them in
-- to relying parties. This takes those sessions away: the people behind them
-- come back through the emailed recovery link, which ends in a passkey.
--
-- Spared:
--   * a restricted session (`restricted_until` set): a recovery's or a
--     sign-up's, which may only enrol a passkey and lapses on its own;
--   * every session of an account with a deletion job: a job written before
--     the restore record took the account's passkeys and kept one session as
--     its only way to cancel, and no job's account loses a session here.
--
-- NOT EXISTS rather than NOT IN, so a NULL anywhere in a subquery cannot
-- empty the match. Reads only account ids and the nullable
-- `restricted_until`, whatever else a row holds. A session another table
-- names (`deletion_jobs.cancel_session_id`) belongs to an account with a job,
-- so it stays. Rotation records of the ended sessions stay until they expire;
-- replaying one ends nothing more.
DELETE FROM `sessions`
WHERE `restricted_until` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `passkeys` WHERE `passkeys`.`account_id` = `sessions`.`account_id`
  )
  AND NOT EXISTS (
    SELECT 1 FROM `deletion_jobs` WHERE `deletion_jobs`.`account_id` = `sessions`.`account_id`
  );
