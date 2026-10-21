/**
 * Security-event email templates.
 *
 * These never include secret material (codes, tokens). The audit row in
 * `security_events` is the signal; the email is the confirmation. Framing
 * mirrors the OTP email-change template ("somebody did this on your
 * account") so a misdirected message is clearly junk.
 *
 * Each names the identity instance the account lives on (`instanceName`),
 * which the sender passes in: this package names no product of its own.
 */

import type { RenderedEmail } from "./index";

/** Data every security notice takes: the identity instance, e.g. "Musubi". */
export interface InstanceNameData {
  readonly instanceName: string;
}

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderRecoveryGenerated({ instanceName: name }: InstanceNameData): RenderedEmail {
  const text = `Somebody generated a new set of recovery codes for your ${name} account. If that was you, no further action is needed — your previous codes are no longer valid.\n\nIf this wasn't you: sign in and review your active sessions at the Sessions tab, then acknowledge the alert.`;
  const html = wrap(
    `<h2>Your ${esc(name)} recovery codes were regenerated</h2><p>Somebody generated a new set of recovery codes for your ${esc(name)} account. If that was you, no further action is needed &mdash; your previous codes are no longer valid.</p><p>If this wasn't you: sign in and review your active sessions at the Sessions tab, then acknowledge the alert.</p>`,
  );
  return { subject: `Your ${name} recovery codes were regenerated`, text, html };
}

export function renderRecoveryConsumed({ instanceName: name }: InstanceNameData): RenderedEmail {
  const text = `A recovery code was used to regain access to your ${name} account. If that was you, no further action is needed.\n\nIf this wasn't you: your account may be compromised. Change any shared passwords, review your active sessions, and acknowledge the alert.`;
  const html = wrap(
    `<h2>A recovery code was used on your ${esc(name)} account</h2><p>A recovery code was used to regain access to your ${esc(name)} account. If that was you, no further action is needed.</p><p>If this wasn't you: your account may be compromised. Change any shared passwords, review your active sessions, and acknowledge the alert.</p>`,
  );
  return { subject: `A recovery code was used on your ${name} account`, text, html };
}

/**
 * The "this wasn't me" link. Single use, expires in 72 hours, and carries the
 * token in the URL **fragment** — mail scanners prefetch links, and a token in
 * the query string would be spent by a security appliance before the recipient
 * ever read the message. The fragment never leaves the browser.
 */
export interface RecoveryUsedData extends InstanceNameData {
  disownUrl: string;
}

/**
 * Sent after an email-OTP or TOTP recovery succeeds. The louder of the two
 * recovery notices: every session on the account has just been revoked and
 * somebody who is not holding a passkey is signed in.
 *
 * Carries no code and does not say which factor was used — a recipient who did
 * not do this learns that it happened and what to do, and an attacker reading
 * the mailbox learns nothing about the account's other factors. The disown link
 * is the exception it has to make: it is useless to anyone who did not receive
 * this message, and without it the notice is a warning with nothing behind it.
 */
export function renderRecoveryUsed({
  disownUrl,
  instanceName: name,
}: RecoveryUsedData): RenderedEmail {
  const text = `Somebody recovered access to your ${name} account without a passkey, using an emailed code or an authenticator app. Every existing session was signed out, and whoever recovered the account can now add a new passkey to it.\n\nIf that was you, no further action is needed.\n\nIf this wasn't you, undo it here — this link works once, and expires in 72 hours:\n${disownUrl}\n\nThat removes the credential the recovery added and signs out every session. Then sign in with a passkey you still hold and review your account.`;
  const html = wrap(
    `<h2>Your ${esc(name)} account was recovered</h2><p>Somebody recovered access to your ${esc(name)} account without a passkey, using an emailed code or an authenticator app. Every existing session was signed out, and whoever recovered the account can now add a new passkey to it.</p><p>If that was you, no further action is needed.</p><p>If this wasn't you, undo it now. This link works once and expires in 72 hours:</p><p><a href="${disownUrl}">This wasn't me &mdash; undo this recovery</a></p><p>That removes the credential the recovery added and signs out every session. Then sign in with a passkey you still hold and review your account.</p>`,
  );
  return { subject: `Your ${name} account was recovered`, text, html };
}

export function renderPasskeyAdded({ instanceName: name }: InstanceNameData): RenderedEmail {
  const text = `A passkey was just added to your ${name} account. If that was you, no further action is needed.\n\nIf this wasn't you: sign in, remove the unexpected credential, and rotate your recovery codes.`;
  const html = wrap(
    `<h2>A passkey was added to your ${esc(name)} account</h2><p>A passkey was just added to your ${esc(name)} account. If that was you, no further action is needed.</p><p>If this wasn't you: sign in, remove the unexpected credential, and rotate your recovery codes.</p>`,
  );
  return { subject: `A passkey was added to your ${name} account`, text, html };
}

export function renderPasskeyRemoved({ instanceName: name }: InstanceNameData): RenderedEmail {
  const text = `A passkey was just removed from your ${name} account. If that was you, no further action is needed.\n\nIf this wasn't you: sign in, review your active sessions, and rotate any remaining credentials.`;
  const html = wrap(
    `<h2>A passkey was removed from your ${esc(name)} account</h2><p>A passkey was just removed from your ${esc(name)} account. If that was you, no further action is needed.</p><p>If this wasn't you: sign in, review your active sessions, and rotate any remaining credentials.</p>`,
  );
  return { subject: `A passkey was removed from your ${name} account`, text, html };
}

export function renderTotpEnrolled({ instanceName: name }: InstanceNameData): RenderedEmail {
  const text = `An authenticator app was just set up on your ${name} account. If that was you, no further action is needed.\n\nIf this wasn't you: sign in, remove the authenticator, and rotate your recovery codes.`;
  const html = wrap(
    `<h2>An authenticator app was added to your ${esc(name)} account</h2><p>An authenticator app was just set up on your ${esc(name)} account. If that was you, no further action is needed.</p><p>If this wasn't you: sign in, remove the authenticator, and rotate your recovery codes.</p>`,
  );
  return { subject: `An authenticator app was added to your ${name} account`, text, html };
}

export function renderTotpDisabled({ instanceName: name }: InstanceNameData): RenderedEmail {
  const text = `The authenticator app on your ${name} account was just removed. If that was you, no further action is needed.\n\nIf this wasn't you: sign in, review your active sessions, and set up an authenticator again.`;
  const html = wrap(
    `<h2>The authenticator app on your ${esc(name)} account was removed</h2><p>The authenticator app on your ${esc(name)} account was just removed. If that was you, no further action is needed.</p><p>If this wasn't you: sign in, review your active sessions, and set up an authenticator again.</p>`,
  );
  return { subject: `The authenticator app on your ${name} account was removed`, text, html };
}

export function renderCrossDeviceLogin({ instanceName: name }: InstanceNameData): RenderedEmail {
  const text = `A new device was just signed in to your ${name} account using cross-device login. If that was you, no further action is needed.\n\nIf this wasn't you: sign in, review your active sessions, and revoke the unknown session.`;
  const html = wrap(
    `<h2>A new device signed in to your ${esc(name)} account</h2><p>A new device was just signed in to your ${esc(name)} account using cross-device login. If that was you, no further action is needed.</p><p>If this wasn't you: sign in, review your active sessions, and revoke the unknown session.</p>`,
  );
  return { subject: `A new device signed in to your ${name} account`, text, html };
}
