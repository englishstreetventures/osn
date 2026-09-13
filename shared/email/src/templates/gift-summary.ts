/**
 * Registry gift-summary email template.
 *
 * Sent once per wedding, by cire's retention sweep, at the moment the sweep
 * deletes that wedding's guest data — a year after the last event. It carries
 * the aggregate cire keeps on `registry_settings.gift_summary_json` and says
 * plainly that the detail behind it is gone.
 *
 * The copy is deliberately flat about that. "Archived", "moved to cold
 * storage", or "contact support to retrieve" would all be untrue: the rows are
 * deleted and nobody can get them back. A couple reading this a year later
 * should not come away with a wrong idea of what still exists.
 *
 * Aggregates only, by construction — no household, no name, no note. A summary
 * carrying those would be the deletion undone in the email instead of the row
 * next door. See `wiki/compliance/retention.md` §Contributions.
 */

import type { RenderedEmail } from "./index";

export interface RegistryGiftSummaryData {
  /** The wedding as the couple named it, e.g. "Ama & Jonah". */
  readonly weddingName: string;
  /** `YYYY-MM-DD` of the last event — the far end of the retained year. */
  readonly finalEventOn: string;
  /** `YYYY-MM-DD` the sweep ran and the detail went. */
  readonly sweptOn: string;
  /** Money gifts that actually settled. */
  readonly giftCount: number;
  /**
   * The total, ALREADY formatted in the wedding's own currency by the caller —
   * cire owns `weddings.currency` and the locale question, and a template that
   * did money maths would be a second place for it to go wrong. `null` when no
   * money gift settled.
   */
  readonly giftTotal: string | null;
  /** Gifts from the couple's list: marked bought, and still reserved. */
  readonly listPurchased: number;
  readonly listReserved: number;
}

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderRegistryGiftSummary(data: RegistryGiftSummaryData): RenderedEmail {
  const subject = `Your gift record from ${data.weddingName}`;
  const moneyLine =
    data.giftCount > 0 && data.giftTotal
      ? `Money gifts: ${data.giftCount}, totalling ${data.giftTotal}`
      : `Money gifts: none`;
  const listLine = `Gifts from your list: ${data.listPurchased} bought, ${data.listReserved} reserved`;

  const text = [
    `Hello,`,
    ``,
    `A year has passed since the last event of ${data.weddingName}, on ${data.finalEventOn}. As we said we would, we have now deleted the guest data from that wedding, and that includes every individual gift record.`,
    ``,
    `We counted it first. Here is what your registry held, as of ${data.sweptOn}:`,
    ``,
    `  ${moneyLine}`,
    `  ${listLine}`,
    ``,
    `The detail behind those numbers is gone — who gave what, and any message they sent with it. We have not kept a copy and we cannot get it back. The payments themselves are still in your own payment account and your bank records.`,
    ``,
    `Please keep this email. It is the record we kept for you.`,
    ``,
    `Cire Weddings`,
  ].join("\n");

  const html = wrap(
    `<h2>Your gift record from ${esc(data.weddingName)}</h2>` +
      `<p>Hello,</p>` +
      `<p>A year has passed since the last event of ${esc(data.weddingName)}, on ${esc(data.finalEventOn)}. As we said we would, we have now deleted the guest data from that wedding, and that includes every individual gift record.</p>` +
      `<p>We counted it first. Here is what your registry held, as of ${esc(data.sweptOn)}:</p>` +
      `<ul><li>${esc(moneyLine)}</li><li>${esc(listLine)}</li></ul>` +
      `<p>The detail behind those numbers is gone — who gave what, and any message they sent with it. We have not kept a copy and we cannot get it back. The payments themselves are still in your own payment account and your bank records.</p>` +
      `<p style="color:#666;font-size:14px">Please keep this email. It is the record we kept for you.</p>` +
      `<p style="color:#666;font-size:14px">Cire Weddings</p>`,
  );

  return { subject, text, html };
}
