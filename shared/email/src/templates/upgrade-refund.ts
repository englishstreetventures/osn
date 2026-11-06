/**
 * Upgrade refund notice.
 *
 * Sent to a wedding's owners when cire refunds an upgrade payment it could not
 * grant: the money went back in full, and here is where to write. It names no
 * reason, since the reason can be another owner's act (a delete, a comp), and
 * it carries no guest data: the wedding's name, the tier, the amount and
 * cire's contact address.
 *
 * The template does no money maths: cire formats the amount, so there is one
 * place for a currency's minor unit to go wrong.
 */

import type { RenderedEmail } from "./index";

export interface UpgradeRefundData {
  /** The wedding as the couple named it, e.g. "Ama & Jonah". */
  readonly weddingName: string;
  /** The tier the payment was for, e.g. "Gold". `null` for a legacy product. */
  readonly tierName: string | null;
  /** What was refunded, already formatted, e.g. "A$79.00". `null` when unknown. */
  readonly amount: string | null;
  /** Where to write with a question. */
  readonly contactEmail: string;
  /** The organiser portal. */
  readonly portalUrl: string;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderUpgradeRefund(data: UpgradeRefundData): RenderedEmail {
  const subject = "Your Cire upgrade payment has been refunded";
  const wedding = data.weddingName.replaceAll(/[\r\n]+/g, " ");
  const to = data.tierName === null ? "" : ` to ${data.tierName}`;
  const payment = data.amount === null ? "your payment" : `your payment of ${data.amount}`;
  const lead = `We could not upgrade ${wedding}${to}, so we have refunded ${payment} in full.`;
  const when = `Your card provider can take 5 to 10 business days to show it. Nothing else about the wedding has changed.`;
  const ask = `Questions? Write to us at ${data.contactEmail}.`;

  const text = [
    `Hello,`,
    ``,
    lead,
    ``,
    when,
    ``,
    ask,
    ``,
    data.portalUrl,
    ``,
    `Cire Weddings`,
  ].join("\n");

  const html = wrap(
    `<h2>${esc(subject)}</h2>` +
      `<p>Hello,</p>` +
      `<p>${esc(lead)}</p>` +
      `<p>${esc(when)}</p>` +
      `<p>Questions? Write to us at <a href="mailto:${esc(data.contactEmail)}">${esc(data.contactEmail)}</a>.</p>` +
      `<p><a href="${esc(data.portalUrl)}">Open the organiser portal</a></p>` +
      `<p style="color:#666;font-size:14px">Cire Weddings</p>`,
  );

  return { subject, text, html };
}
