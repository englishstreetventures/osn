/**
 * OTP-bearing email templates. All four share the same shape but differ
 * in framing: registration is "welcome, verify your address"; step-up is
 * "confirm a sensitive action"; recovery and email-change use the
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

export function renderRegistrationOtp(data: OtpData): RenderedEmail {
  const name = data.instanceName;
  const text = `Your ${name} verification code is: ${data.code}\n\nThis code expires in ${String(data.ttlMinutes)} minutes.`;
  const html = wrap(
    `<h2>Verify your ${esc(name)} email</h2><p>Your verification code is:</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${esc(data.code)}</p><p style="color:#666">This code expires in ${String(data.ttlMinutes)} minutes.</p>`,
  );
  return { subject: `Verify your ${name} email`, text, html };
}

export function renderStepUpOtp(data: OtpData): RenderedEmail {
  const name = data.instanceName;
  const text = `Your ${name} step-up code is: ${data.code}\n\nUse this to confirm a security-sensitive action. Expires in ${String(data.ttlMinutes)} minutes.`;
  const html = wrap(
    `<h2>Confirm a sensitive action</h2><p>Your ${esc(name)} step-up code is:</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${esc(data.code)}</p><p style="color:#666">Use this to confirm a security-sensitive action. Expires in ${String(data.ttlMinutes)} minutes.</p>`,
  );
  return { subject: "Confirm a sensitive action", text, html };
}

/**
 * The code that gets a locked-out user back in, from
 * `POST /login/recovery/email/begin`.
 *
 * Framed as "somebody asked for this", like the email-change template, and here
 * that framing does more work than politeness: the endpoint is UNAUTHENTICATED,
 * so anyone who knows the address can cause this message to arrive (capped at
 * 3 per 24 h per account).
 * The recipient is the account holder, so the body has to read as something a
 * stranger may have triggered — and say plainly that ignoring it is safe and
 * costs nothing.
 *
 * It names no handle, no display name and nothing else account-specific: the
 * address is the only thing the sender proved they know, and the message must
 * not confirm anything further to somebody reading over a shoulder.
 */
export function renderRecoveryOtp(data: OtpData): RenderedEmail {
  const name = data.instanceName;
  const text = `Somebody asked to recover the ${name} account for this email address. If that wasn't you, you can ignore this message safely — nothing has changed on the account.\n\nYour ${name} account recovery code is: ${data.code}\n\nThis code expires in ${String(data.ttlMinutes)} minutes. Entering it signs you in only to add a new passkey.`;
  const html = wrap(
    `<h2>Recover your ${esc(name)} account</h2><p>Somebody asked to recover the ${esc(name)} account for this email address. If that wasn't you, you can ignore this message safely &mdash; nothing has changed on the account.</p><p>Your account recovery code is:</p><p style="font-size:24px;font-weight:600;letter-spacing:2px">${esc(data.code)}</p><p style="color:#666">This code expires in ${String(data.ttlMinutes)} minutes. Entering it signs you in only to add a new passkey.</p>`,
  );
  return { subject: `Recover your ${name} account`, text, html };
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
