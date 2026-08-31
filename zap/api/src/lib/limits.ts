/**
 * Platform-wide limits for Zap messaging.
 *
 * Single source of truth for cap constants. Changing a limit here is an
 * auditable edit — never inline these into a schema.
 */

/** Maximum members in a group or event chat. */
export const MAX_CHAT_MEMBERS = 500;

/** Maximum ciphertext length in bytes (base64-encoded). ~256 KB. */
export const MAX_CIPHERTEXT_LENGTH = 262_144;

/** Maximum nonce length in bytes (base64-encoded). */
export const MAX_NONCE_LENGTH = 128;

/** Maximum title length for group/event chats. */
export const MAX_CHAT_TITLE_LENGTH = 200;

/** Default page size for message pagination. */
export const DEFAULT_MESSAGE_LIMIT = 50;

/** Maximum page size for message pagination. */
export const MAX_MESSAGE_LIMIT = 100;

/** Default page size for chat-list pagination (P-W1). */
export const DEFAULT_CHAT_LIMIT = 50;

/** Maximum page size for chat-list pagination (P-W1). */
export const MAX_CHAT_LIMIT = 100;

/** Default page size for chat-member pagination (P-W4). */
export const DEFAULT_MEMBER_LIMIT = 100;

/** Maximum page size for chat-member pagination — members cap at MAX_CHAT_MEMBERS. */
export const MAX_MEMBER_LIMIT = MAX_CHAT_MEMBERS;

/** Max length of a server-visible c2b message body (plaintext chars). */
export const MAX_BODY_LENGTH = 8_000;

/**
 * Maximum member rows per INSERT statement in a batched chat-creation write.
 * A member row binds 5 parameters (id, chat_id, profile_id, role,
 * joined_at) — 20 rows/statement keeps each INSERT at 100 bound parameters,
 * D1's per-query ceiling.
 */
export const MAX_MEMBER_ROWS_PER_INSERT = 20;

/**
 * Maximum profile IDs accepted per DSAR export request. Each ID is one bound
 * parameter in the `IN (...)` clauses the account-export loaders build —
 * capped to stay under D1's ~100-bound-parameter ceiling per query.
 */
export const MAX_EXPORT_PROFILE_IDS = 100;
