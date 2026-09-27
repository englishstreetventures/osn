import { Effect, Schema } from "effect";

/**
 * Longest first or last name a household may give its plus-one. Generous for
 * any real name; the bound exists because the value is typed by a guest and
 * then shown to the couple, stored in change warnings and written into CSVs.
 */
export const PLUS_ONE_NAME_MAX = 100;

/**
 * Characters a name never needs and that would mislead the couple reading it:
 * every control (`Cc`) and format (`Cf`) character — invisible ones such as the
 * zero-width space, and the direction marks, overrides and isolates that make a
 * name render as something other than what was stored — and the line and
 * paragraph separators (`Zl`, `Zp`). Two format characters are allowed back,
 * the zero-width non-joiner and joiner (U+200C, U+200D), which some scripts and
 * emoji need. Matching by category covers characters Unicode adds later.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const JOINERS = /[\u200c\u200d]/gu;

/**
 * Letters that render as nothing at all: the Hangul fillers and the blank
 * Braille pattern. They are letters by category, so the "has a visible
 * character" test below would otherwise accept a name made of them.
 */
const BLANK_LETTERS = /[\u115f\u1160\u3164\uffa0\u2800]/u;

function hasHiddenCharacter(value: string): boolean {
  return HIDDEN.test(value.replace(JOINERS, "")) || BLANK_LETTERS.test(value);
}

/** Whether a name shows anything: at least one letter or digit. */
const isVisible = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);

const nameChecks = [
  Schema.isMaxLength(PLUS_ONE_NAME_MAX),
  Schema.makeFilter((value: string) =>
    hasHiddenCharacter(value) ? "Must not contain invisible or control characters" : undefined,
  ),
] as const;

/** A first name: bounded, printable, and with at least one letter or digit, so
 *  it cannot look blank. The service stores it trimmed. */
const FirstName = Schema.String.check(
  ...nameChecks,
  Schema.makeFilter((value: string) => (isVisible(value) ? undefined : "Must not be blank")),
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
 * Most plus-ones one household can hold: the largest guest cap is 1000, and
 * every plus-one needs a guest of their own household who brought them.
 */
export const PLUS_ONE_REMOVALS_MAX = 500;

/**
 * One plus-one the organiser was shown and agreed to remove, as `GET …/guests`
 * served them. The name is part of who they are: a household can replace its
 * plus-one by renaming the row it already has, so the id alone would not show
 * that the organiser saw the person being removed. Echoed, not typed, so it is
 * only bounded — the service compares it with what is stored, exactly.
 */
const ConfirmedPlusOne = Schema.Struct({
  guestId: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  firstName: Schema.String.check(Schema.isMaxLength(PLUS_ONE_NAME_MAX)),
  lastName: Schema.String.check(Schema.isMaxLength(PLUS_ONE_NAME_MAX)),
});
export type ConfirmedPlusOne = Schema.Schema.Type<typeof ConfirmedPlusOne>;

/**
 * Body for both permission routes, `PUT …/guests/:guestId/plus-one` and
 * `PUT …/families/:familyId/plus-one`.
 *
 * `removePlusOnes` lists the plus-ones the organiser confirmed removing. Turning
 * permission off deletes the plus-ones in scope only when every one of them is
 * on this list, so a delete never reaches someone the organiser was not shown;
 * left out, it confirms nobody. Ignored when `allowed` is true.
 *
 * Unknown keys are refused rather than dropped: a misspelled confirmation would
 * otherwise decode as "confirms nobody" and be refused as `plus_one_named` again
 * and again, with nothing to say why.
 */
export const PlusOnePermissionBody = Schema.Struct({
  allowed: Schema.Boolean,
  removePlusOnes: Schema.Array(ConfirmedPlusOne)
    .check(Schema.isMaxLength(PLUS_ONE_REMOVALS_MAX))
    .pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PlusOnePermissionBody = Schema.Schema.Type<typeof PlusOnePermissionBody>;
