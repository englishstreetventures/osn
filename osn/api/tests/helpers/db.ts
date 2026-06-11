import { Database } from "bun:sqlite";

import * as schema from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { EmailService, makeLogEmailLive } from "@shared/email";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Layer } from "effect";

export function createTestLayer() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      passkey_user_id TEXT NOT NULL UNIQUE,
      max_profiles INTEGER NOT NULL DEFAULT 5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      processing_restricted_at INTEGER
    )
  `);
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_url TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`CREATE INDEX users_account_idx ON users (account_id)`);
  sqlite.run(`
    CREATE TABLE passkeys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at INTEGER NOT NULL,
      label TEXT,
      last_used_at INTEGER,
      aaguid TEXT,
      backup_eligible INTEGER,
      backup_state INTEGER,
      updated_at INTEGER
    )
  `);
  sqlite.run(`CREATE INDEX passkeys_account_id_idx ON passkeys (account_id)`);
  sqlite.run(`
    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES users(id),
      addressee_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (requester_id, addressee_id)
    )
  `);
  sqlite.run(`CREATE INDEX connections_requester_idx ON connections (requester_id)`);
  sqlite.run(`CREATE INDEX connections_addressee_idx ON connections (addressee_id)`);
  sqlite.run(`
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY,
      blocker_id TEXT NOT NULL REFERENCES users(id),
      blocked_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE (blocker_id, blocked_id)
    )
  `);
  sqlite.run(`CREATE INDEX blocks_blocker_idx ON blocks (blocker_id)`);
  sqlite.run(`CREATE INDEX blocks_blocked_idx ON blocks (blocked_id)`);
  sqlite.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      family_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      ua_label TEXT,
      ip_hash TEXT,
      last_used_at INTEGER
    )
  `);
  sqlite.run(`CREATE INDEX sessions_account_idx ON sessions (account_id)`);
  sqlite.run(`CREATE INDEX sessions_family_idx ON sessions (family_id)`);
  sqlite.run(`CREATE INDEX sessions_account_last_used_idx ON sessions (account_id, last_used_at)`);
  sqlite.run(`
    CREATE TABLE email_changes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      previous_email TEXT NOT NULL,
      new_email TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`CREATE INDEX email_changes_account_idx ON email_changes (account_id)`);
  sqlite.run(`CREATE INDEX email_changes_completed_at_idx ON email_changes (completed_at)`);
  sqlite.run(`
    CREATE TABLE security_events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      ip_hash TEXT,
      ua_label TEXT
    )
  `);
  sqlite.run(
    `CREATE INDEX security_events_unacked_idx ON security_events (account_id, created_at) WHERE acknowledged_at IS NULL`,
  );
  sqlite.run(`
    CREATE TABLE recovery_codes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      code_hash TEXT NOT NULL UNIQUE,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`CREATE INDEX recovery_codes_account_idx ON recovery_codes (account_id)`);
  sqlite.run(`
    CREATE TABLE service_accounts (
      service_id TEXT PRIMARY KEY,
      allowed_scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE service_account_keys (
      key_id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES service_accounts(service_id),
      public_key_jwk TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    )
  `);
  sqlite.run(`CREATE INDEX service_account_keys_service_idx ON service_account_keys (service_id)`);
  sqlite.run(`
    CREATE TABLE organisations (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      avatar_url TEXT,
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`CREATE INDEX organisations_owner_idx ON organisations (owner_id)`);
  sqlite.run(`
    CREATE TABLE organisation_members (
      id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL REFERENCES organisations(id),
      profile_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (organisation_id, profile_id)
    )
  `);
  sqlite.run(`CREATE INDEX org_members_org_idx ON organisation_members (organisation_id)`);
  sqlite.run(`CREATE INDEX org_members_profile_idx ON organisation_members (profile_id)`);
  sqlite.run(`
    CREATE TABLE app_enrollments (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      app TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER
    )
  `);
  sqlite.run(`CREATE INDEX app_enrollments_account_idx ON app_enrollments (account_id)`);
  sqlite.run(
    `CREATE INDEX app_enrollments_active_idx ON app_enrollments (account_id, app) WHERE left_at IS NULL`,
  );
  sqlite.run(`
    CREATE TABLE deletion_jobs (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      soft_deleted_at INTEGER NOT NULL,
      hard_delete_at INTEGER NOT NULL,
      pulse_done_at INTEGER,
      zap_done_at INTEGER,
      reason TEXT NOT NULL DEFAULT 'user_request',
      cancel_session_id TEXT
    )
  `);
  sqlite.run(`CREATE INDEX deletion_jobs_hard_delete_idx ON deletion_jobs (hard_delete_at)`);
  sqlite.run(
    `CREATE INDEX deletion_jobs_pulse_pending_idx ON deletion_jobs (soft_deleted_at) WHERE pulse_done_at IS NULL`,
  );
  sqlite.run(
    `CREATE INDEX deletion_jobs_zap_pending_idx ON deletion_jobs (soft_deleted_at) WHERE zap_done_at IS NULL`,
  );
  const db = drizzle(sqlite, { schema });
  const dbLayer = Layer.succeed(Db, { db });
  const emailLayer = makeLogEmailLive().layer;
  return Layer.merge(dbLayer, emailLayer);
}

/**
 * Variant of `createTestLayer()` that exposes the email recorder so
 * tests can assert on captured sends. Replaces the old pattern of
 * setting a `sendEmail` callback in `AuthConfig`.
 */
export function createTestLayerWithEmailRecorder() {
  const inner = createTestLayer();
  const email = makeLogEmailLive();
  return {
    layer: Layer.merge(inner, email.layer),
    recorded: email.recorded,
    reset: email.reset,
  };
}

// Re-export for tests that want to build their own capture recorder.
export { EmailService, makeLogEmailLive };
