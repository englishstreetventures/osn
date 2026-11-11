/**
 * OTP-bearing email templates. Both share the same shape but differ in
 * framing: step-up is "confirm a sensitive action"; email change uses the
 * "somebody asked for this" framing so a misdirected message is clearly junk
 * and useless as a phishing template.
 *
 * Each names the identity instance it comes from (`instanceName`), which the
 * sender passes in: this package names no product of its own.
 *
 * The HTML version uses a single outer div and no external assets —
 * every mail client renders it consistently and no content loads from
 * a third-party origin (which would trigger spam heuristics and privacy
 * prompts).
 */

import type { RenderedEmail } from "./index";

export interface OtpData {
  readonly code: string;
  readonly ttlMinutes: number;
  /** The identity instance the code is for, as people know it — e.g. "Musubi". */
  readonly instanceName: string;
}

/**
 * Basic HTML escape for template interpolations. OTPs are digits, so they
 * can't carry markup, but we escape defensively in case template data ever
 * carries user-controlled content in the future.
 */
const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderStepUpOtp(data: OtpData): RenderedEmail {
  const name = data.instanceName;
  const text = `Your ${name} step-up code is: ${data.code}\n\nUse this to confirm a security-sensitive action. Expires in ${String(data.ttlMinutes)} minutes.`;
  const html = wrap(
    `<h2>Confirm a sensitive action</h2><p>Your ${esc(name)} step-up code is:</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${esc(data.code)}</p><p style="color:#666">Use this to confirm a security-sensitive action. Expires in ${String(data.ttlMinutes)} minutes.</p>`,
  );
  return { subject: "Confirm a sensitive action", text, html };
}

export function renderEmailChangeOtp(data: OtpData): RenderedEmail {
  // "Somebody asked for this" framing, so a misdirected message is clearly
  // junk to the recipient and useless as a phishing template.
  const name = data.instanceName;
  const text = `Somebody asked to use this email address for their ${name} account. If that wasn't you, you can ignore this message safely.\n\nYour ${name} email change code is: ${data.code}\n\nExpires in ${String(data.ttlMinutes)} minutes.`;
  const html = wrap(
    `<h2>Confirm your new ${esc(name)} email</h2><p>Somebody asked to use this email address for their ${esc(name)} account. If that wasn't you, you can ignore this message safely.</p><p>Your email change code is:</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${esc(data.code)}</p><p style="color:#666">Expires in ${String(data.ttlMinutes)} minutes.</p>`,
  );
  return { subject: `Confirm your new ${name} email`, text, html };
}
