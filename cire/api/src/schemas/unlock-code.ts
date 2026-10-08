import { Schema } from "effect";

/**
 * The longest `unlockCode` a body may carry. A code is 19 characters as
 * printed (`xxxx-xxxx-xxxx-xxxx`); the bound leaves room for spaces typed
 * around it and stops a body hashing an arbitrary length of text.
 */
const MAX_UNLOCK_CODE_CHARS = 64;

/** `POST /unlock-code`. The code as the owner typed it: case, dashes and
 *  spaces are the service's to fold. */
export const RedeemUnlockCodeBody = Schema.Struct({
  unlockCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_UNLOCK_CODE_CHARS)),
});
export type RedeemUnlockCodeBody = Schema.Schema.Type<typeof RedeemUnlockCodeBody>;
