/**
 * Format an event price for display.
 *
 * Events store price in minor units (cents/pence/yen). Free events have
 * both fields null. The rule: null OR 0 → "Free". Otherwise format via
 * Intl with the stored ISO currency.
 *
 * Kept deliberately permissive on the currency arg — the API restricts
 * to the SUPPORTED_CURRENCIES allowlist, but this helper accepts any
 * string so legacy / future codes don't crash the UI.
 */
const EXPONENT: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};

// P-I1: cache formatters instead of reconstructing on every call. With
// ~6 currencies × a small number of locales this caps at a handful of
// entries; keeps the helper cheap on long feeds.
const formatterCache = new Map<string, Intl.NumberFormat>();

function getFormatter(
  locale: string | undefined,
  currency: string,
  exp: number,
): Intl.NumberFormat {
  const key = `${locale ?? ""}|${currency}|${exp}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  });
  formatterCache.set(key, fmt);
  return fmt;
}

export function formatPrice(
  amount: number | null | undefined,
  currency: string | null | undefined,
  locale?: string,
): string {
  if (amount == null || amount === 0 || !currency) return "Free";
  const exp = EXPONENT[currency] ?? 2;
  const major = amount / 10 ** exp;
  try {
    return getFormatter(locale, currency, exp).format(major);
  } catch {
    return `${currency} ${major.toFixed(exp)}`;
  }
}
