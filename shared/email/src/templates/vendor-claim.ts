/**
 * Vendor claim-invite email template.
 *
 * Sent best-effort when an organiser seeds a directory listing for a vendor.
 * The email carries the claim link so the vendor can take ownership of their
 * listing. It never carries secret material beyond the claim URL (which is
 * already single-use and time-limited at the service layer).
 */

import type { RenderedEmail } from "./index";

export interface VendorClaimInviteData {
  readonly claimUrl: string;
  readonly vendorName: string;
}

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderVendorClaimInvite(data: VendorClaimInviteData): RenderedEmail {
  const subject = `Claim your listing on Cire Weddings`;
  const text = [
    `Hi${data.vendorName ? ` ${data.vendorName}` : ""},`,
    ``,
    `An organiser has created a directory listing for your wedding services on Cire Weddings.`,
    ``,
    `Claim your listing to manage your profile, respond to enquiries, and connect with couples:`,
    ``,
    data.claimUrl,
    ``,
    `If you weren't expecting this or don't offer wedding services, you can safely ignore this message.`,
  ].join("\n");
  const html = wrap(
    `<h2>Claim your listing on Cire Weddings</h2>` +
      `<p>Hi${data.vendorName ? ` ${esc(data.vendorName)}` : ""},</p>` +
      `<p>An organiser has created a directory listing for your wedding services on Cire Weddings.</p>` +
      `<p>Claim your listing to manage your profile, respond to enquiries, and connect with couples:</p>` +
      `<p><a href="${esc(data.claimUrl)}" style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:6px">Claim your listing</a></p>` +
      `<p style="color:#666;font-size:14px">Or copy this link: ${esc(data.claimUrl)}</p>` +
      `<p style="color:#666;font-size:14px">If you weren't expecting this or don't offer wedding services, you can safely ignore this message.</p>`,
  );
  return { subject, text, html };
}
