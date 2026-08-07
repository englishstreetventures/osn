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

/** `null` marks a currency `Intl` rejected — remembered so it is tried once. */
const formatters = new Map<string, Intl.NumberFormat | null>();

function formatterFor(currency: string, wholeUnits: boolean): Intl.NumberFormat | null {
  const key = `${currency}|${wholeUnits ? "0" : "d"}`;
  const hit = formatters.get(key);
  // `null` is a remembered failure and `undefined` is a miss; nothing ever
  // stores `undefined`, so this one comparison distinguishes them.
  if (hit !== undefined) return hit;

  let built: Intl.NumberFormat | null = null;
  try {
    built = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      ...(wholeUnits ? { maximumFractionDigits: 0 } : {}),
    });
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
  const units = minor / 100;
  return formatterFor(currency, wholeUnits)?.format(units) ?? units.toFixed(wholeUnits ? 0 : 2);
}

/** Test-only: drop the memoised formatters so each test starts cold. */
export function __resetMoneyFormatters(): void {
  formatters.clear();
}
