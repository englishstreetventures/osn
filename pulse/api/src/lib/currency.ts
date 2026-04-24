/**
 * Price + currency handling for Pulse events.
 *
 * Prices are stored in minor units (cents/pence/yen) as an integer on the
 * `events.price_amount` column, paired with an ISO 4217 code on
 * `events.price_currency`. Both must be set or both null — enforced in the
 * Effect Schema decoder in `services/events.ts`.
 *
 * Display rule: `price_amount` null OR 0 → "Free". Otherwise format via
 * `Intl.NumberFormat` using the currency.
 */

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

const CURRENCY_EXPONENT: Record<SupportedCurrency, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};

/** Max displayable price in major units — shared cap across all currencies. */
export const MAX_PRICE_MAJOR = 99999.99;

/** Max storable price in minor units. Derived from MAX_PRICE_MAJOR × 100. */
export const MAX_PRICE_MINOR = 9_999_999;

export const isSupportedCurrency = (value: unknown): value is SupportedCurrency =>
  typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);

export const currencyExponent = (currency: SupportedCurrency): number =>
  CURRENCY_EXPONENT[currency];

/**
 * Convert a major-unit input (e.g. 18.50 USD) to minor units (1850).
 * Rounds half-up to the currency's exponent to avoid float drift.
 * Returns null for null, 0, or invalid numbers.
 */
export const toMinorUnits = (major: number, currency: SupportedCurrency): number => {
  const exp = currencyExponent(currency);
  const scale = 10 ** exp;
  return Math.round(major * scale);
};

export const fromMinorUnits = (minor: number, currency: SupportedCurrency): number => {
  const exp = currencyExponent(currency);
  return minor / 10 ** exp;
};
