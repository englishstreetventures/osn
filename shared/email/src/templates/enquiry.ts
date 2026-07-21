/**
 * Enquiry email templates.
 *
 * Three transactional templates for the enquiry thread flow:
 *   - enquiry-new:   sent to vendor when a couple sends a new enquiry
 *   - enquiry-reply: sent to the other party when someone replies in a thread
 *   - enquiry-quote: sent to the couple when a vendor attaches a quote
 */

import type { RenderedEmail } from "./index";

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export interface EnquiryNewData {
  readonly vendorName: string;
  readonly weddingName: string;
  readonly message: string;
  readonly threadUrl: string;
  readonly unclaimed: boolean;
  readonly claimUrl?: string;
}

export function renderEnquiryNew(data: EnquiryNewData): RenderedEmail {
  const subject = `New enquiry from ${data.weddingName}`;
  const claimTextBlock =
    data.unclaimed && data.claimUrl
      ? [``, `Claim your listing to reply and manage your enquiries:`, data.claimUrl]
      : [``, `Reply to this enquiry:`, data.threadUrl];
  const text = [
    `Hi ${data.vendorName},`,
    ``,
    `${data.weddingName} sent you an enquiry on Cire Weddings:`,
    ``,
    data.message,
    ...claimTextBlock,
    ``,
    `— Cire Weddings`,
  ].join("\n");
  const claimHtmlBlock =
    data.unclaimed && data.claimUrl
      ? `<p>Claim your listing to reply and manage your enquiries:</p><p><a href="${esc(data.claimUrl)}">Claim your listing</a></p>`
      : `<p><a href="${esc(data.threadUrl)}">Reply to this enquiry</a></p>`;
  const html = wrap(
    `<h2>New enquiry from ${esc(data.weddingName)}</h2>` +
      `<p>Hi ${esc(data.vendorName)},</p>` +
      `<p>${esc(data.weddingName)} sent you an enquiry on Cire Weddings:</p>` +
      `<blockquote>${esc(data.message)}</blockquote>` +
      claimHtmlBlock,
  );
  return { subject, text, html };
}

export interface EnquiryReplyData {
  readonly recipientName: string;
  readonly senderName: string;
  readonly message: string;
  readonly threadUrl: string;
}

export function renderEnquiryReply(data: EnquiryReplyData): RenderedEmail {
  const subject = `New reply from ${data.senderName}`;
  const text = [
    `Hi ${data.recipientName},`,
    ``,
    `${data.senderName} replied to your enquiry thread:`,
    ``,
    data.message,
    ``,
    `View the thread: ${data.threadUrl}`,
    ``,
    `— Cire Weddings`,
  ].join("\n");
  const html = wrap(
    `<h2>New reply from ${esc(data.senderName)}</h2>` +
      `<p>Hi ${esc(data.recipientName)},</p>` +
      `<blockquote>${esc(data.message)}</blockquote>` +
      `<p><a href="${esc(data.threadUrl)}">View the thread</a></p>`,
  );
  return { subject, text, html };
}

export interface EnquiryQuoteData {
  readonly vendorName: string;
  readonly amountFormatted: string;
  readonly note?: string;
  readonly threadUrl: string;
}

export function renderEnquiryQuote(data: EnquiryQuoteData): RenderedEmail {
  const subject = `You received a quote from ${data.vendorName}`;
  const text = [
    `${data.vendorName} sent you a quote: ${data.amountFormatted}`,
    ...(data.note ? [``, data.note] : []),
    ``,
    `View the quote: ${data.threadUrl}`,
    ``,
    `This quote is informational — no booking or payment happens on Cire.`,
    ``,
    `— Cire Weddings`,
  ].join("\n");
  const html = wrap(
    `<h2>You received a quote from ${esc(data.vendorName)}</h2>` +
      `<p><strong>${esc(data.amountFormatted)}</strong></p>` +
      (data.note ? `<blockquote>${esc(data.note)}</blockquote>` : ``) +
      `<p><a href="${esc(data.threadUrl)}">View the quote</a></p>` +
      `<p style="color:#666;font-size:13px">This quote is informational — no booking or payment happens on Cire.</p>`,
  );
  return { subject, text, html };
}
