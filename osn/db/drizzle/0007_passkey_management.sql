-- Phase 5 M-PK: passkey management surface (list/rename/delete) + discoverable login
--
-- Adds metadata columns so Settings → Passkeys can render a usable list:
--   • `label`           — user-editable friendly name ("Laptop", "YubiKey 5C")
--   • `last_used_at`    — unix seconds of most recent assertion / step-up
--   • `aaguid`          — authenticator-model UUID (FIDO MDS key for default label)
--   • `backup_eligible` — sync-capable authenticator flag from WebAuthn
--   • `backup_state`    — whether this credential has been synced
--   • `updated_at`      — any metadata change (rename, counter bump, sync flip)
--
-- All nullable — existing rows default to NULL, and the service layer treats
-- NULL as "unknown" without blocking list/rename/delete flows.

ALTER TABLE `passkeys` ADD `label` text;--> statement-breakpoint
ALTER TABLE `passkeys` ADD `last_used_at` integer;--> statement-breakpoint
ALTER TABLE `passkeys` ADD `aaguid` text;--> statement-breakpoint
ALTER TABLE `passkeys` ADD `backup_eligible` integer;--> statement-breakpoint
ALTER TABLE `passkeys` ADD `backup_state` integer;--> statement-breakpoint
ALTER TABLE `passkeys` ADD `updated_at` integer;
