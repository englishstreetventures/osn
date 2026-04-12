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
