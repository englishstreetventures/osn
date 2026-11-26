/**
 * Payout account holder erased notice.
 *
 * Sent to a wedding's remaining owners when the owner who connected the Stripe
 * account its money gifts are paid into deletes their OSN account. The
 * account's record goes with them, so guests cannot give money until another
 * owner connects one: the copy says so and links the registry's Settings tab,
 * where Money gifts is.
 *
 * It names no one: the person's identity is being erased. No guest data and no
 * account details: the wedding's name and a link to the portal. The words hold
 * whether money gifts were on or off, and whether the account could charge.
 */

import { emailButton } from "./button";
import type { RenderedEmail } from "./index";

export interface RegistryPayoutHolderErasedData {
  /** The wedding as the couple named it, e.g. "Ama & Jonah". */
  readonly weddingName: string;
  /** The registry's Settings tab in the organiser portal, which holds Money gifts. */
  readonly moneyGiftsUrl: string;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** A line break in a subject header would start a new header. */
const oneLine = (s: string): string => s.replaceAll(/[\r\n]+/g, " ");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderRegistryPayoutHolderErased(
  data: RegistryPayoutHolderErasedData,
): RenderedEmail {
  const wedding = oneLine(data.weddingName);
  const subject = oneLine(`Money gifts on ${wedding} need a new Stripe account`);
  const lead = `An owner of ${wedding} who connected its Stripe account for money gifts has deleted their account. Guests cannot give money until an owner connects a Stripe account.`;
  const next = `Connect your own account to take gifts, or leave money gifts off, in the organiser portal: Registry, then Settings, under Money gifts.`;
  const kept = `Gifts already given stay in the Stripe account they were paid into, and any refund or dispute on them is handled there.`;

  const text = [
    `Hello,`,
    ``,
    lead,
    ``,
    next,
    ``,
    kept,
    ``,
    `Registry settings: ${data.moneyGiftsUrl}`,
    ``,
    `Cire Weddings`,
  ].join("\n");

  const html = wrap(
    `<h2>${esc(subject)}</h2>` +
      `<p>Hello,</p>` +
      `<p>${esc(lead)}</p>` +
      `<p>${esc(next)}</p>` +
      `<p>${esc(kept)}</p>` +
      emailButton(data.moneyGiftsUrl, "Open Money gifts") +
      `<p style="color:#666;font-size:14px;word-break:break-all">${esc(data.moneyGiftsUrl)}</p>` +
      `<p style="color:#666;font-size:14px">Cire Weddings</p>`,
  );

  return { subject, text, html };
}
