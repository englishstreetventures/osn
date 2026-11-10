/**
 * Emailed-link templates: a message that carries one link which, opened and
 * confirmed, proves the reader holds this mailbox. Sign-up and account
 * recovery send one today; step-up and email change send their own with the
 * same data shape.
 *
 * The link's secret rides in its fragment, which no browser sends to a server,
 * so the message is the only place it exists in clear. Opening the link does
 * nothing on its own: the page it opens asks the reader to confirm, because
 * mail scanners open every link in a message before a person does.
 *
 * Each names the identity instance it comes from (`instanceName`), which the
 * sender passes in: this package names no product of its own.
 */

import type { RenderedEmail } from "./index";

export interface LinkData {
  /** The link to open, secret included. */
  readonly url: string;
  /** Minutes the link stays usable. */
  readonly ttlMinutes: number;
  /** The identity instance the link is for, as people know it — e.g. "Musubi". */
  readonly instanceName: string;
}

export interface RegistrationLinkData extends LinkData {
  /**
   * The handle the sign-up creates. Named so that a reader who did not ask
   * for it has something to check before confirming: whoever began the
   * sign-up, not the reader, gets the account.
   */
  readonly handle: string;
}

export interface RecoveryLinkData extends LinkData {
  /**
   * The device that asked, as a coarse label ("Chrome on macOS"), or null when
   * it gave none. Named so a reader can tell their own request from one
   * someone else began: whoever began it, not the reader, gets back in.
   */
  readonly device: string | null;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderRegistrationLink(data: RegistrationLinkData): RenderedEmail {
  const name = data.instanceName;
  const minutes = String(data.ttlMinutes);
  const text = `Someone asked to create the ${name} account @${data.handle} with this email address. If that was you, open this link and confirm:\n\n${data.url}\n\nThe link works for ${minutes} minutes. The device that asked finishes signing up, not the one you open the link on.\n\nIf you didn't ask for @${data.handle}, ignore this email. No account is made.`;
  const html = wrap(
    `<h2>Confirm your ${esc(name)} email</h2><p>Someone asked to create the ${esc(name)} account <strong>@${esc(data.handle)}</strong> with this email address. If that was you, open this link and confirm:</p><p><a href="${esc(data.url)}" style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:6px">Confirm this email</a></p><p style="color:#666;word-break:break-all">${esc(data.url)}</p><p style="color:#666">The link works for ${minutes} minutes. The device that asked finishes signing up, not the one you open the link on.</p><p style="color:#666">If you didn't ask for @${esc(data.handle)}, ignore this email. No account is made.</p>`,
  );
  return { subject: `Confirm your ${name} email`, text, html };
}

/**
 * The link that gets a locked-out person back in, from
 * `POST /login/recovery/email/begin`.
 *
 * Framed as "someone asked for this": the endpoint is unauthenticated, so
 * anyone who knows the address can cause this message to arrive. It says how
 * to refuse ("I didn't ask for this" on the link's page), and that ignoring it
 * changes nothing. It names no handle, no display name and nothing else about
 * the account: the address is the only thing the sender proved they know.
 */
export function renderRecoveryLink(data: RecoveryLinkData): RenderedEmail {
  const name = data.instanceName;
  const minutes = String(data.ttlMinutes);
  const asked = data.device ? ` from ${data.device}` : "";
  const text = `Someone asked${asked} to get back into the ${name} account for this email address. If that was you, open this link and pick the number your screen shows:\n\n${data.url}\n\nThe link works for ${minutes} minutes. The device that asked gets back in, not the one you open the link on. It can only add a passkey, and every other device is signed out.\n\nIf you didn't ask, open the link and choose "I didn't ask for this", or ignore this email. Nothing changes on the account.`;
  const html = wrap(
    `<h2>Recover your ${esc(name)} account</h2><p>Someone asked${esc(asked)} to get back into the ${esc(name)} account for this email address. If that was you, open this link and pick the number your screen shows:</p><p><a href="${esc(data.url)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#0a0a0a;color:#ffffff;text-decoration:none;font-weight:600">Get back in</a></p><p style="color:#666;word-break:break-all">${esc(data.url)}</p><p style="color:#666">The link works for ${minutes} minutes. The device that asked gets back in, not the one you open the link on. It can only add a passkey, and every other device is signed out.</p><p style="color:#666">If you didn't ask, open the link and choose &ldquo;I didn't ask for this&rdquo;, or ignore this email. Nothing changes on the account.</p>`,
  );
  return { subject: `Recover your ${name} account`, text, html };
}
