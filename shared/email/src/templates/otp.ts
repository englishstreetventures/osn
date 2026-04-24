/**
 * OTP-bearing email templates. All three share the same shape but differ
 * in framing: registration is "welcome, verify your address"; step-up is
 * "confirm a sensitive action"; email-change uses the S-L5 "somebody
 * asked for this" framing so a misdirected message is clearly junk and
 * useless as a phishing template.
 *
 * The HTML version uses a single outer div and no external assets —
 * every mail client renders it consistently and no content loads from
 * a third-party origin (which would trigger spam heuristics and privacy
 * prompts).
 */

import type { RenderedEmail } from "./index";

interface OtpData {
  readonly code: string;
  readonly ttlMinutes: number;
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

export function renderRegistrationOtp(data: OtpData): RenderedEmail {
  const text = `Your OSN verification code is: ${data.code}\n\nThis code expires in ${String(data.ttlMinutes)} minutes.`;
  const html = wrap(
    `<h2>Verify your OSN email</h2><p>Your verification code is:</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${esc(data.code)}</p><p style="color:#666">This code expires in ${String(data.ttlMinutes)} minutes.</p>`,
  );
  return { subject: "Verify your OSN email", text, html };
}

export function renderStepUpOtp(data: OtpData): RenderedEmail {
  const text = `Your OSN step-up code is: ${data.code}\n\nUse this to confirm a security-sensitive action. Expires in ${String(data.ttlMinutes)} minutes.`;
  const html = wrap(
    `<h2>Confirm a sensitive action</h2><p>Your step-up code is:</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${esc(data.code)}</p><p style="color:#666">Use this to confirm a security-sensitive action. Expires in ${String(data.ttlMinutes)} minutes.</p>`,
  );
  return { subject: "Confirm a sensitive action", text, html };
}

export function renderEmailChangeOtp(data: OtpData): RenderedEmail {
  // S-L5: "somebody asked for this" framing so a misdirected message is
  // clearly junk to the recipient and useless as a phishing template.
  const text = `An OSN account holder requested this email address be associated with their account. If that wasn't you, you can ignore this message safely.\n\nYour OSN email change code is: ${data.code}\n\nExpires in ${String(data.ttlMinutes)} minutes.`;
  const html = wrap(
    `<h2>Confirm your new OSN email</h2><p>An OSN account holder requested this email address be associated with their account. If that wasn't you, you can ignore this message safely.</p><p>Your email change code is:</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${esc(data.code)}</p><p style="color:#666">Expires in ${String(data.ttlMinutes)} minutes.</p>`,
  );
  return { subject: "Confirm your new OSN email", text, html };
}
