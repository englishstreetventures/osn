/**
 * Registry gift-summary email template.
 *
 * Sent once per wedding, by cire's retention sweep, at the moment the sweep
 * deletes that wedding's guest data — a year after the last event. It carries
 * the record cire keeps on `registry_settings.gift_summary_json` — the counts,
 * the totals and each money gift's amount and day — and says plainly that who
 * gave each gift, and what they wrote, is gone.
 *
 * The copy is deliberately flat about that. "Archived", "moved to cold
 * storage", or "contact support to retrieve" would all be untrue: the rows are
 * deleted and nobody can get them back. A couple reading this a year later
 * should not come away with a wrong idea of what still exists.
 *
 * No household, no name, no note — a record carrying those would be the
 * deletion undone in the email instead of the row next door. See
 * `wiki/compliance/retention.md` §Contributions.
 *
 * The template does no money maths. cire formats every amount (it owns
 * `weddings.currency` and the locale question), so there is one place for a
 * currency's minor unit to go wrong, not two.
 */

import type { RenderedEmail } from "./index";

/** One currency's money gifts, already formatted. */
export interface RegistryGiftSummaryTotal {
  /** ISO code, e.g. "AUD". */
  readonly currency: string;
  /** The total, formatted in `currency`, e.g. "A$1,134.50". */
  readonly total: string;
  /** How many gifts it adds, or null where the record does not know. */
  readonly count: number | null;
}

/** One money gift, as the couple were given it. */
export interface RegistryGiftSummaryGift {
  /** `YYYY-MM-DD` the gift was given. */
  readonly on: string;
  /** The amount as given, formatted in its own currency. */
  readonly amount: string;
  /**
   * The gift's currency when it is not the couple's — it is then outside their
   * total and the line says so. Null for a gift in the couple's currency.
   */
  readonly otherCurrency: string | null;
}

export interface RegistryGiftSummaryData {
  /** The wedding as the couple named it, e.g. "Ama & Jonah". */
  readonly weddingName: string;
  /** `YYYY-MM-DD` of the last event — the far end of the retained year. */
  readonly finalEventOn: string;
  /** `YYYY-MM-DD` the sweep ran and the detail went. */
  readonly sweptOn: string;
  /** Money gifts that actually settled, in every currency. */
  readonly giftCount: number;
  /** The couple's currency — the wedding's own. */
  readonly giftCurrency: string;
  /**
   * One total per currency gifts came in: the couple's currency first, then
   * the rest in code order. Empty when no money gift settled.
   */
  readonly giftTotals: readonly RegistryGiftSummaryTotal[];
  /** Each money gift, oldest first. */
  readonly gifts: readonly RegistryGiftSummaryGift[];
  /** Gifts counted in `giftCount` but not in `gifts`. */
  readonly giftsUnlisted: number;
  /** Gifts from the couple's list: marked bought, and still reserved. */
  readonly listPurchased: number;
  readonly listReserved: number;
}

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

/**
 * The money line. Every total names the gifts it adds: one currency is
 * "N, totalling X"; several put each count beside its own total, so a count of
 * every gift never sits next to a total that adds fewer of them.
 */
function moneyLine(data: RegistryGiftSummaryData): string {
  if (data.giftCount === 0 || data.giftTotals.length === 0) return "Money gifts: none";
  const [only] = data.giftTotals;
  if (data.giftTotals.length === 1 && only && only.currency === data.giftCurrency) {
    return `Money gifts: ${data.giftCount}, totalling ${only.total}`;
  }
  const parts = data.giftTotals.map((t) =>
    t.count === null
      ? `in ${t.currency}, totalling ${t.total}`
      : `${t.count} in ${t.currency}, totalling ${t.total}`,
  );
  return `Money gifts: ${data.giftCount} — ${parts.join("; ")}`;
}

export function renderRegistryGiftSummary(data: RegistryGiftSummaryData): RenderedEmail {
  const subject = `Your gift record from ${data.weddingName}`;
  const money = moneyLine(data);
  const listLine = `Gifts from your list: ${data.listPurchased} bought, ${data.listReserved} reserved`;
  const coupleHasTotal = data.giftTotals.some((t) => t.currency === data.giftCurrency);
  /** The smaller line under a gift given in another currency. */
  const outsideNote = (currency: string): string =>
    coupleHasTotal
      ? `Given in ${currency} — outside the ${data.giftCurrency} total`
      : `Given in ${currency}`;
  const listed = data.gifts.length > 0;
  const n = data.giftsUnlisted;
  // "And N more" under a list; with no list there is nothing to be "more" than.
  const unlisted =
    n === 0
      ? null
      : listed
        ? `And ${n} more money ${n === 1 ? "gift" : "gifts"}, counted above but not listed one by one.`
        : `${n} money ${n === 1 ? "gift is" : "gifts are"} counted above but not listed one by one.`;

  const textList = listed
    ? [
        ``,
        `Each money gift, by the day it was given:`,
        ``,
        ...data.gifts.flatMap((g) => [
          `  ${g.on}  ${g.amount}`,
          ...(g.otherCurrency === null ? [] : [`              ${outsideNote(g.otherCurrency)}`]),
        ]),
        ...(unlisted === null ? [] : [``, `  ${unlisted}`]),
      ]
    : unlisted === null
      ? []
      : [``, `  ${unlisted}`];

  const text = [
    `Hello,`,
    ``,
    `A year has passed since the last event of ${data.weddingName}, on ${data.finalEventOn}. As we said we would, we have now deleted the guest data from that wedding: who gave each gift, and any message they sent with it.`,
    ``,
    `We counted it first. Here is what your registry held, as of ${data.sweptOn}:`,
    ``,
    `  ${money}`,
    `  ${listLine}`,
    ...textList,
    ``,
    `We kept the amount and the day of each money gift, so you can still see what you were given. Who gave it, and any message they sent, are gone. We have not kept a copy and we cannot get them back. The payments themselves are still in your own payment account and your bank records.`,
    ``,
    `Please keep this email. It is the record we kept for you.`,
    ``,
    `Cire Weddings`,
  ].join("\n");

  const htmlList = listed
    ? `<p>Each money gift, by the day it was given:</p>` +
      `<ul style="list-style:none;padding:0;margin:0 0 16px">` +
      data.gifts
        .map(
          (g) =>
            `<li style="margin:0 0 6px">${esc(g.on)} · ${esc(g.amount)}` +
            (g.otherCurrency === null
              ? ""
              : `<br><span style="font-size:13px;color:#666">${esc(outsideNote(g.otherCurrency))}</span>`) +
            `</li>`,
        )
        .join("") +
      (unlisted === null ? "" : `<li style="margin:8px 0 0">${esc(unlisted)}</li>`) +
      `</ul>`
    : unlisted === null
      ? ""
      : `<p>${esc(unlisted)}</p>`;

  const html = wrap(
    `<h2>Your gift record from ${esc(data.weddingName)}</h2>` +
      `<p>Hello,</p>` +
      `<p>A year has passed since the last event of ${esc(data.weddingName)}, on ${esc(data.finalEventOn)}. As we said we would, we have now deleted the guest data from that wedding: who gave each gift, and any message they sent with it.</p>` +
      `<p>We counted it first. Here is what your registry held, as of ${esc(data.sweptOn)}:</p>` +
      `<ul><li>${esc(money)}</li><li>${esc(listLine)}</li></ul>` +
      htmlList +
      `<p>We kept the amount and the day of each money gift, so you can still see what you were given. Who gave it, and any message they sent, are gone. We have not kept a copy and we cannot get them back. The payments themselves are still in your own payment account and your bank records.</p>` +
      `<p style="color:#666;font-size:14px">Please keep this email. It is the record we kept for you.</p>` +
      `<p style="color:#666;font-size:14px">Cire Weddings</p>`,
  );

  return { subject, text, html };
}
