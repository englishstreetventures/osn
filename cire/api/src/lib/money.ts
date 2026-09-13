/**
 * Minor units into the bare decimal a spreadsheet can add up.
 *
 * The API stores every amount in minor units and hands them to the clients that
 * way; the CSV exports are the one place it has to print money itself, and a
 * download wants a plain number in one column with the currency in the next —
 * "12.50", not "$12.50", which a spreadsheet imports as text.
 *
 * The exponent is NOT always 2. JPY has no minor unit at all (1000 minor units
 * is ¥1000, not ¥10) and KWD/BHD/JOD use 3, so a fixed `/ 100` mis-states a
 * foreign gift by 100× — the kind of wrong nobody notices until it is in front
 * of the couple. It is read off `Intl.NumberFormat`, memoised per currency
 * because constructing one resolves locale + currency data and the export calls
 * this once per row.
 *
 * `Intl.NumberFormat` THROWS on an unknown currency code, and a stored row can
 * carry whatever Stripe sent, so a rejected code is remembered as rejected and
 * falls back to 2 — the same shape as the portal's `cire/host/src/lib/money.ts`.
 */

/** `null` marks a currency `Intl` rejected — remembered so it is tried once. */
const exponents = new Map<string, number | null>();

function exponentFor(currency: string): number {
  const hit = exponents.get(currency);
  if (hit !== undefined) return hit ?? 2;
  try {
    const resolved = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    const exponent = resolved ?? 2;
    exponents.set(currency, exponent);
    return exponent;
  } catch {
    exponents.set(currency, null);
    return 2;
  }
}

/** `minorToDecimal(1250, "AUD")` → `"12.50"`; `minorToDecimal(1000, "JPY")` → `"1000"`. */
export function minorToDecimal(minor: number, currency: string): string {
  const exponent = exponentFor(currency);
  return (minor / 10 ** exponent).toFixed(exponent);
}

/** Test-only: drop the memoised exponents so each test starts cold. */
export function resetMoneyCache(): void {
  exponents.clear();
}
