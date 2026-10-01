// Currency formatting for the organiser's minor-unit amounts (cents).
//
// ENQ-P-W3: the enquiry inbox and thread each built a fresh
// `Intl.NumberFormat` per call, inside a `<For>` row — so an inbox of N quoted
// enquiries constructed N formatters on every render. Constructing one is the
// expensive part of `Intl` (locale + currency data resolution); formatting with
// a built one is cheap. The set of (currency, precision) pairs a wedding uses is
// tiny and stable, so they are built once and reused.
//
// The failure path is cached too, and deliberately so: `Intl.NumberFormat`
// THROWS on an unknown currency code, and a throw-per-row is far worse than the
// construction it replaced. A currency that fails once is remembered as failed.

/** Distinct formatter shapes the organiser asks for. */
export interface MoneyFormatOptions {
  /** Drop the cents (the thread's compact quote line). Default: keep them. */
  wholeUnits?: boolean;
}

/** The two lines a foreign-currency gift renders as. See {@link formatMinorPair}. */
export interface MoneyPair {
  /** The amount as it was actually given — always shown. */
  given: string;
  /** Its primary-currency equivalent, or `null` when the two already match. */
  primary: string | null;
}

/** `null` marks a currency `Intl` rejected — remembered so it is tried once. */
const formatters = new Map<string, Intl.NumberFormat | null>();

/** Minor-unit exponent per currency, memoised off the formatter above. */
const exponents = new Map<string, number>();

/**
 * How many minor units make one major unit, as a power of ten.
 *
 * NOT always 2. JPY has no minor unit at all (exponent 0, so 1000 minor units is
 * ¥1000, not ¥10) and KWD/BHD/JOD use 3. The old fixed `/ 100` was invisible
 * while every wedding was in AUD; with a per-wedding primary currency and gifts
 * arriving in other currencies it silently mis-states amounts by 100×, which is
 * the kind of wrong nobody notices until it is in front of a guest.
 *
 * Read off the formatter this module already builds, so asking for the exponent
 * never constructs an extra `Intl.NumberFormat` — the memoisation contract the
 * tests pin. A currency `Intl` rejects falls back to 2, matching the plain-number
 * fallback below.
 */
function exponentFor(currency: string): number {
  const hit = exponents.get(currency);
  if (hit !== undefined) return hit;
  // Deliberately the NON-wholeUnits formatter: the compact one pins
  // `maximumFractionDigits: 0`, so reading the exponent off it would report 0 for
  // every currency.
  const resolved = formatterFor(currency, false)?.resolvedOptions().maximumFractionDigits;
  const exponent = resolved ?? 2;
  exponents.set(currency, exponent);
  return exponent;
}

function formatterFor(currency: string, wholeUnits: boolean): Intl.NumberFormat | null {
  const key = `${currency}|${wholeUnits ? "0" : "d"}`;
  const hit = formatters.get(key);
  // `null` is a remembered failure and `undefined` is a miss; nothing ever
  // stores `undefined`, so this one comparison distinguishes them.
  if (hit !== undefined) return hit;

  let built: Intl.NumberFormat | null = null;
  try {
    const options: Intl.NumberFormatOptions = { style: "currency", currency };
    if (wholeUnits) options.maximumFractionDigits = 0;
    built = new Intl.NumberFormat(undefined, options);
  } catch {
    // Unknown/malformed currency code — the caller falls back to a bare number.
    built = null;
  }
  formatters.set(key, built);
  return built;
}

/**
 * Format a minor-unit amount (cents) for display.
 *
 * Falls back to a plain fixed-point number when the currency code is one
 * `Intl` will not accept, so a bad code shows an amount rather than throwing
 * through a render.
 */
export function formatMinor(
  minor: number,
  currency: string,
  options: MoneyFormatOptions = {},
): string {
  const wholeUnits = options.wholeUnits === true;
  const exponent = exponentFor(currency);
  const units = minor / 10 ** exponent;
  return (
    formatterFor(currency, wholeUnits)?.format(units) ?? units.toFixed(wholeUnits ? 0 : exponent)
  );
}

/**
 * Parse a major-unit amount typed into a price field ("12.50") into minor units.
 *
 * The inverse of {@link formatMinor}, and it exists for the same reason that one
 * reads the exponent instead of dividing by 100: the portal's older price inputs
 * multiply by a hardcoded 100, which is right for AUD and wrong by 100× the
 * moment a wedding's primary currency is JPY. Reuses the memoised exponent, so
 * parsing constructs no extra formatter.
 *
 * Rounds half-way amounts up by decimal rules, not by the binary product:
 * `1.005 * 100` is `100.49999999999999` in floating point, so "1.005" AUD would
 * come out at 100. The decimal point is shifted in the number's shortest string
 * form instead, so "1.005" AUD is 101.
 *
 * Returns `null` for empty, non-numeric or negative input, and for a positive
 * amount below half the currency's smallest unit (¥0.4, 0.0004 KWD), which
 * would otherwise save as zero without a word. A typed 0 parses to 0. Callers
 * show {@link belowSmallestUnitError} for that last case.
 */
export function parseMinor(text: string, currency: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const units = Number(trimmed);
  if (!Number.isFinite(units) || units < 0) return null;
  const minor = unitsToMinor(units, exponentFor(currency));
  if (minor === 0 && units > 0) return null;
  return minor;
}

/** A non-negative major-unit amount in minor units, rounded half up by decimal rules. */
function unitsToMinor(units: number, exponent: number): number {
  const text = String(units);
  // Exponent notation only appears below 1e-6, which rounds to 0 at any
  // currency's exponent, or at 1e21 and above, which is already a whole number.
  if (text.includes("e")) return Math.round(units * 10 ** exponent);
  const [whole = "0", fraction = ""] = text.split(".");
  const digits = fraction.padEnd(exponent + 1, "0");
  const roundUp = digits.charAt(exponent) >= "5" ? 1 : 0;
  return Number(whole + digits.slice(0, exponent)) + roundUp;
}

/**
 * The message for a positive amount {@link parseMinor} refused because it
 * rounds to zero minor units: "Amounts between 0 and ¥1 are not allowed."
 * `null` when that is not why the text was refused.
 */
export function belowSmallestUnitError(text: string, currency: string): string | null {
  const units = Number(text.trim());
  if (!Number.isFinite(units) || units <= 0) return null;
  if (unitsToMinor(units, exponentFor(currency)) !== 0) return null;
  return `Amounts between 0 and ${formatMinor(1, currency)} are not allowed.`;
}

/**
 * Minor units back into the bare major-unit string a `<input type="number">`
 * holds — "12.50", not "$12.50".
 *
 * The other half of {@link parseMinor}, and needed for the same reason: an edit
 * form seeded with `minor / 100` is wrong by 100× in JPY the moment the host
 * opens the row, and SAVES that wrong number if they touch anything else. No
 * currency symbol and no grouping separators, because a number input rejects
 * both and would silently come up empty.
 */
export function minorToInput(minor: number, currency: string): string {
  const exponent = exponentFor(currency);
  return (minor / 10 ** exponent).toFixed(exponent);
}

/**
 * Format a gift the way the host should read it: the amount **as given** first,
 * with its primary-currency equivalent underneath — and a single figure when the
 * gift already arrived in the wedding's primary currency.
 *
 * The caller passes the primary side only when the stored row HAS one. A
 * contribution in the primary currency carries no FX snapshot (those columns are
 * NULL), which is the common case, so `primary` comes back `null` and the UI
 * renders one line. This function never converts anything itself: rates are
 * snapshotted per gift at charge time, and re-deriving one at render would make
 * the gift log quietly re-value itself as rates move.
 */
export function formatMinorPair(
  given: { minor: number; currency: string },
  primary: { minor: number; currency: string } | null,
  options: MoneyFormatOptions = {},
): MoneyPair {
  const givenText = formatMinor(given.minor, given.currency, options);
  // Same currency ⇒ the second line would just repeat the first. Guard on the
  // code rather than trusting the caller, since a same-currency snapshot is a
  // legitimate thing for a webhook to have written.
  if (!primary || primary.currency === given.currency) return { given: givenText, primary: null };
  return { given: givenText, primary: formatMinor(primary.minor, primary.currency, options) };
}

/** Test-only: drop the memoised formatters so each test starts cold. */
export function __resetMoneyFormatters(): void {
  formatters.clear();
  exponents.clear();
}
