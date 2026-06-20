import { CIRE_WEB_URL } from "./osn";

/**
 * Build the ready-to-send invite message an organiser copies for a family. A
 * fixed THREE-LINE shape — cleaner pasted into WhatsApp/SMS than the old single
 * line — carrying no PII beyond the family's own code + the public guest-site URL:
 *
 *   {message}
 *   {guestSiteUrl}
 *   {familyCode}
 *
 * Line 1 is the host's `customMessage` if they set one, else the built-in default
 * prose. Line 2 is this wedding's path on the public guest site
 * (`CIRE_WEB_URL/<slug>` / `PUBLIC_CIRE_WEB_URL/<slug>`). The guest site is SSR +
 * path-routed, so the link must carry the wedding slug in the PATH — sending the
 * bare origin would render whatever the bare domain resolves to (the primary
 * wedding), not necessarily this one. Line 3 is the family's claim code; guests
 * claim by entering it on that page (no `?code=` needed — the code is in the
 * message for the guest to type).
 *
 * `customMessage` is the optional per-wedding override (trimmed; an empty/
 * whitespace-only value falls back to the default prose), so the URL + code are
 * always appended automatically regardless of what the host wrote.
 */
export function buildInviteMessage(
  weddingName: string,
  familyCode: string,
  weddingSlug: string,
  customMessage?: string | null,
): string {
  const guestUrl = `${CIRE_WEB_URL}/${encodeURIComponent(weddingSlug)}`;
  const message =
    customMessage?.trim() ||
    `You're invited to ${weddingName}! View your invitation and RSVP below.`;
  return `${message}\n${guestUrl}\n${familyCode}`;
}

/**
 * Copy `text` to the clipboard, returning whether it succeeded. Prefers the
 * async Clipboard API; falls back to a hidden-textarea `execCommand('copy')`
 * for non-secure contexts (HTTP / older browsers) where `navigator.clipboard`
 * is unavailable. Never throws — a failure resolves to `false` so the caller can
 * surface a "copy this manually" affordance instead of crashing.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand path below.
  }

  try {
    if (typeof document === "undefined") return false;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
