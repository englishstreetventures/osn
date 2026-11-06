/**
 * The number a person carries from the screen that waits for an emailed link to
 * the page the link opens, which asks them to pick it: one to six digits, 0-9.
 *
 * Every view that draws one checks it here, so the two screens accept the same
 * strings. A value that fails is drawn nowhere. `\d` in JavaScript matches the
 * ASCII digits only, with or without the `u` flag.
 */
const PAIRING_CODE = /^\d{1,6}$/;

export function isPairingCode(value: string | undefined): value is string {
  return value !== undefined && PAIRING_CODE.test(value);
}
