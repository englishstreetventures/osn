/**
 * Security-event email templates.
 *
 * These never include secret material (codes, tokens). The audit row in
 * `security_events` is the signal; the email is the confirmation. Framing
 * mirrors the OTP email-change template ("somebody did this on your
 * account") so a misdirected message is clearly junk.
 */

import type { RenderedEmail } from "./index";

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderRecoveryGenerated(): RenderedEmail {
  const text = `Somebody generated a new set of OSN account recovery codes on your account. If that was you, no further action is needed — your previous codes are no longer valid.\n\nIf this wasn't you: sign in and review your active sessions at the Sessions tab, then acknowledge the alert.`;
  const html = wrap(
    `<h2>Your OSN recovery codes were regenerated</h2><p>Somebody generated a new set of OSN account recovery codes on your account. If that was you, no further action is needed &mdash; your previous codes are no longer valid.</p><p>If this wasn't you: sign in and review your active sessions at the Sessions tab, then acknowledge the alert.</p>`,
  );
  return { subject: "Your OSN recovery codes were regenerated", text, html };
}

export function renderRecoveryConsumed(): RenderedEmail {
  const text = `An OSN recovery code was used to regain access to your account. If that was you, no further action is needed.\n\nIf this wasn't you: your account may be compromised. Change any shared passwords, review your active sessions, and acknowledge the alert.`;
  const html = wrap(
    `<h2>An OSN recovery code was used on your account</h2><p>An OSN recovery code was used to regain access to your account. If that was you, no further action is needed.</p><p>If this wasn't you: your account may be compromised. Change any shared passwords, review your active sessions, and acknowledge the alert.</p>`,
  );
  return { subject: "An OSN recovery code was used on your account", text, html };
}

export function renderPasskeyAdded(): RenderedEmail {
  const text = `A passkey was just added to your OSN account. If that was you, no further action is needed.\n\nIf this wasn't you: sign in, remove the unexpected credential, and rotate your recovery codes.`;
  const html = wrap(
    `<h2>A passkey was added to your OSN account</h2><p>A passkey was just added to your OSN account. If that was you, no further action is needed.</p><p>If this wasn't you: sign in, remove the unexpected credential, and rotate your recovery codes.</p>`,
  );
  return { subject: "A passkey was added to your OSN account", text, html };
}

export function renderPasskeyRemoved(): RenderedEmail {
  const text = `A passkey was just removed from your OSN account. If that was you, no further action is needed.\n\nIf this wasn't you: sign in, review your active sessions, and rotate any remaining credentials.`;
  const html = wrap(
    `<h2>A passkey was removed from your OSN account</h2><p>A passkey was just removed from your OSN account. If that was you, no further action is needed.</p><p>If this wasn't you: sign in, review your active sessions, and rotate any remaining credentials.</p>`,
  );
  return { subject: "A passkey was removed from your OSN account", text, html };
}

export function renderCrossDeviceLogin(): RenderedEmail {
  const text = `A new device was just signed in to your OSN account using cross-device login. If that was you, no further action is needed.\n\nIf this wasn't you: sign in, review your active sessions, and revoke the unknown session.`;
  const html = wrap(
    `<h2>A new device signed in to your OSN account</h2><p>A new device was just signed in to your OSN account using cross-device login. If that was you, no further action is needed.</p><p>If this wasn't you: sign in, review your active sessions, and revoke the unknown session.</p>`,
  );
  return { subject: "A new device signed in to your OSN account", text, html };
}
