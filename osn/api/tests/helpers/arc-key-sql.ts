/**
 * The statement `publishedOutboundKeyById` sends, as drizzle writes it.
 * `tests/routes/arc-key-by-id.test.ts` holds the code to it, and
 * `tests/d1/worker-e2e.test.ts` reads its query plan and rows read on D1.
 */
export const KEY_BY_ID_SQL =
  'select "key_id", "public_key_jwk", "expires_at" from "arc_outbound_keys" where (("arc_outbound_keys"."key_id" >= ?) and ("arc_outbound_keys"."key_id" < ?)) limit ?';
