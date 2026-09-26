import { Effect, Schema } from "effect";

/**
 * Longest first or last name a household may give its plus-one. Generous for
 * any real name; the bound exists because the value is typed by a guest and
 * then shown to the couple, stored in change warnings and written into CSVs.
 */
export const PLUS_ONE_NAME_MAX = 100;

/**
 * Code points a name never needs and that would mislead the couple reading it:
 * C0 and C1 control characters, and the bidirectional overrides and isolates
 * that can make a name render as something other than what was stored.
 */
function hasHiddenCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

const nameChecks = [
  Schema.isMaxLength(PLUS_ONE_NAME_MAX),
  Schema.makeFilter((value: string) =>
    hasHiddenCharacter(value) ? "Must not contain control characters" : undefined,
  ),
] as const;

/** A first name: bounded, printable, and not blank once trimmed. The service
 *  stores it trimmed. */
const FirstName = Schema.String.check(
  ...nameChecks,
  Schema.makeFilter((value: string) => (value.trim().length > 0 ? undefined : "Must not be blank")),
);

/** A last name: bounded and printable, and may be empty — not everyone has one. */
const LastName = Schema.String.check(...nameChecks);

/** Body for `PUT /api/plus-one/:guestId`: the plus-one's name. */
export const PlusOneNameBody = Schema.Struct({
  firstName: FirstName,
  lastName: LastName.pipe(Schema.withDecodingDefaultType(Effect.succeed(""))),
});
export type PlusOneNameBody = Schema.Schema.Type<typeof PlusOneNameBody>;

/**
 * Body for `PUT …/guests/:guestId/plus-one`. `removePlusOne` must be set to turn
 * permission off for a guest whose plus-one is already named: that deletes the
 * plus-one and their replies, so it is never a side effect of `allowed: false`
 * alone.
 */
export const GuestPlusOnePermissionBody = Schema.Struct({
  allowed: Schema.Boolean,
  removePlusOne: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
});
export type GuestPlusOnePermissionBody = Schema.Schema.Type<typeof GuestPlusOnePermissionBody>;

/** Body for `PUT …/families/:familyId/plus-one`: the same rule, household-wide. */
export const HouseholdPlusOnePermissionBody = Schema.Struct({
  allowed: Schema.Boolean,
  removePlusOnes: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
});
export type HouseholdPlusOnePermissionBody = Schema.Schema.Type<
  typeof HouseholdPlusOnePermissionBody
>;
