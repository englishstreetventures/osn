import { CIRE_WEB_URL } from "./osn";

/**
 * Build the ready-to-send invite message an organiser copies for a family. One
 * line, no PII beyond the family's own code + the public guest-site URL:
 *
 *   You're invited to {weddingName}! View your invitation and RSVP at
 *   {guestSiteUrl} — your family code is {CODE}.
 *
 * The URL is the public guest site (`CIRE_WEB_URL` / `PUBLIC_CIRE_WEB_URL`) the
 * organiser build already knows — guests claim by entering their code there, so
 * the bare origin is the right link (no `?code=` needed; the code is in the
 * message for the guest to type).
 */
export function buildInviteMessage(weddingName: string, familyCode: string): string {
  return `You're invited to ${weddingName}! View your invitation and RSVP at ${CIRE_WEB_URL} — your family code is ${familyCode}.`;
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
