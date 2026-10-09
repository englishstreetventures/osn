/**
 * Minor units into money a person or a spreadsheet can read.
 *
 * The API stores every amount in minor units and hands them to the clients that
 * way. It prints money itself in two places: the CSV exports, which want a bare
 * decimal in one column with the currency in the next — "12.50", not "$12.50",
 * which a spreadsheet imports as text — and the emails it sends, which want the
 * amount as a person reads it ({@link formatMinor}).
 *
 * The exponent is NOT always 2. JPY has no minor unit at all (1000 minor units
 * is ¥1000, not ¥10) and KWD/BHD/JOD use 3, so a fixed `/ 100` mis-states a
 * foreign gift by 100× — the kind of wrong nobody notices until it is in front
 * of the couple. It is read off `Intl.NumberFormat`. The formatter and the
 * exponent are both memoised per currency, because constructing one resolves
 * locale and currency data and an export calls this once per row.
 *
 * `Intl.NumberFormat` THROWS on an unknown currency code, and a stored row can
 * carry whatever Stripe sent, so a rejected code is remembered as rejected and
 * falls back to 2 — the same shape as the portal's `cire/host/src/lib/money.ts`.
 */

/** `null` marks a currency `Intl` rejected — remembered so it is tried once. */
const formatters = new Map<string, Intl.NumberFormat | null>();

/** Minor-unit exponent per currency, read once off the formatter above. */
const exponents = new Map<string, number>();

function formatterFor(currency: string): Intl.NumberFormat | null {
  const hit = formatters.get(currency);
  // `null` is a remembered rejection and `undefined` a miss; nothing ever
  // stores `undefined`, so this one comparison tells them apart.
  if (hit !== undefined) return hit;
  let built: Intl.NumberFormat | null = null;
  try {
    built = new Intl.NumberFormat(undefined, { style: "currency", currency });
  } catch {
    built = null;
  }
  formatters.set(currency, built);
  return built;
}

function exponentFor(currency: string): number {
  const hit = exponents.get(currency);
  if (hit !== undefined) return hit;
  const exponent = formatterFor(currency)?.resolvedOptions().maximumFractionDigits ?? 2;
  exponents.set(currency, exponent);
  return exponent;
}

/** `minorToDecimal(1250, "AUD")` → `"12.50"`; `minorToDecimal(1000, "JPY")` → `"1000"`. */
export function minorToDecimal(minor: number, currency: string): string {
  const exponent = exponentFor(currency);
  return (minor / 10 ** exponent).toFixed(exponent);
}

/**
 * A minor-unit amount as a person reads it, in the runtime's locale:
 * `formatMinor(45000, "AUD")` → `"A$450.00"`, `formatMinor(1000, "JPY")` →
 * `"¥1,000"`. A code `Intl` rejects prints the bare decimal and the code, so a
 * bad row still shows an amount and says what it is in: `"125.00 XX"`.
 */
export function formatMinor(minor: number, currency: string): string {
  const formatter = formatterFor(currency);
  if (!formatter) return `${minorToDecimal(minor, currency)} ${currency}`;
  return formatter.format(minor / 10 ** exponentFor(currency));
}

/** Test-only: drop the memoised formatters and exponents so each test starts cold. */
export function resetMoneyCache(): void {
  formatters.clear();
  exponents.clear();
}
