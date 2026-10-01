/**
 * Wedding owner notices.
 *
 * Cire lets every owner of a wedding act alone: any owner may remove or demote
 * another, step down, or delete the wedding. These two emails are how the
 * others find out. Each names who acted, so an owner who did not expect the
 * change knows whom to ask, and an owner whose session someone else is using
 * sees the change made in their name.
 *
 * No guest data, by construction: the wedding's name, the people involved (by
 * the name and handle they chose on OSN), and a link to the portal.
 */

import type { RenderedEmail } from "./index";

/** The role a demoted owner now holds. */
export type WeddingOwnerNewRole = "editor" | "viewer" | "helper";

/** Who this copy of the notice is for. */
export type WeddingOwnerAudience =
  /** The person removed or demoted — the actor too, when they stepped down. */
  | "subject"
  /** The owner who removed or demoted someone else. */
  | "actor"
  /** Every other remaining owner. */
  | "owner";

export interface WeddingOwnerChangeData {
  /** The wedding as the couple named it, e.g. "Ama & Jonah". */
  readonly weddingName: string;
  /** Who acted, e.g. "Ama Mensah (@ama)". `null` when OSN could not say. */
  readonly actorName: string | null;
  /** Who was removed or demoted. `null` when OSN could not say. */
  readonly subjectName: string | null;
  /** `removed` — no seat any more; `demoted` — still seated, below owner. */
  readonly change: "removed" | "demoted";
  /** The role a demoted owner now holds. Ignored for `removed`. */
  readonly newRole?: WeddingOwnerNewRole;
  readonly audience: WeddingOwnerAudience;
  /** True when the subject acted on their own seat (stepped down or left). */
  readonly self: boolean;
  /** The organiser portal. */
  readonly portalUrl: string;
}

export interface WeddingDeleteStartedData {
  readonly weddingName: string;
  /** Who deleted it. `null` when OSN could not say. */
  readonly actorName: string | null;
  /** When the restore window closes, already formatted, e.g. "9 October 2026, 14:05 UTC". */
  readonly restoreUntil: string;
  /** The restore window in days. */
  readonly restoreDays: number;
  /** The organiser portal. */
  readonly portalUrl: string;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A line break in a subject header would start a new header. */
const oneLine = (s: string): string => s.replaceAll(/[\r\n]+/g, " ");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

const article = (role: WeddingOwnerNewRole): string => (role === "editor" ? "an" : "a");

/** The lead sentence and the closing advice for one owner-change notice. */
interface OwnerChangeCopy {
  readonly lead: string;
  readonly advice: string;
}

function ownerChangeCopy(data: WeddingOwnerChangeData): OwnerChangeCopy {
  const wedding = data.weddingName;
  const actor = data.actorName ?? "Another owner";
  const subject = data.subjectName ?? "an owner";
  const role = data.newRole ?? "editor";
  const asRole = `${article(role)} ${role}`;
  const demoted = data.change === "demoted";

  const check = `If you did not expect this, sign in to the organiser portal and check who can manage the wedding. Any owner can change it.`;

  if (data.audience === "subject") {
    if (data.self) {
      return {
        lead: demoted
          ? `You stepped down as an owner of ${wedding}. You are now ${asRole}.`
          : `You left ${wedding}. You were one of its owners.`,
        advice: `If this was not you, someone else is signed in to your account: secure it, then ask one of the wedding's other owners to add you back.`,
      };
    }
    return {
      lead: demoted
        ? `${actor} changed your role on ${wedding} from owner to ${role}.`
        : `${actor} removed you as an owner of ${wedding}. You no longer have access to it.`,
      advice: `If you think this is a mistake, ask one of the wedding's other owners.`,
    };
  }

  if (data.audience === "actor") {
    return {
      lead: demoted
        ? `You changed ${subject}'s role on ${wedding} from owner to ${role}.`
        : `You removed ${subject} as an owner of ${wedding}.`,
      advice: `We send this to every owner, you included. If this was not you, someone else is signed in to your account: secure it, then sign in to the organiser portal and check who can manage the wedding.`,
    };
  }

  if (data.self) {
    return {
      lead: demoted
        ? `${data.subjectName ?? "One of the owners"} stepped down as an owner of ${wedding} and is now ${asRole}.`
        : `${data.subjectName ?? "One of the owners"} left ${wedding}. They were one of its owners.`,
      advice: check,
    };
  }
  return {
    lead: demoted
      ? `${actor} changed ${subject}'s role on ${wedding} from owner to ${role}.`
      : `${actor} removed ${subject} as an owner of ${wedding}.`,
    advice: check,
  };
}

export function renderWeddingOwnerChange(data: WeddingOwnerChangeData): RenderedEmail {
  const subject = oneLine(`An owner change on ${data.weddingName}`);
  const { lead, advice } = ownerChangeCopy(data);

  const text = [
    `Hello,`,
    ``,
    lead,
    ``,
    advice,
    ``,
    `Organiser portal: ${data.portalUrl}`,
    ``,
    `Cire Weddings`,
  ].join("\n");

  const html = wrap(
    `<h2>${esc(subject)}</h2>` +
      `<p>Hello,</p>` +
      `<p>${esc(lead)}</p>` +
      `<p>${esc(advice)}</p>` +
      `<p><a href="${esc(data.portalUrl)}">Open the organiser portal</a></p>` +
      `<p style="color:#666;font-size:14px">Cire Weddings</p>`,
  );

  return { subject, text, html };
}

export function renderWeddingDeleteStarted(data: WeddingDeleteStartedData): RenderedEmail {
  const subject = oneLine(`${data.weddingName} has been deleted`);
  const actor = data.actorName ?? "Another owner";
  const days = `${data.restoreDays} ${data.restoreDays === 1 ? "day" : "days"}`;

  const lead = `${actor} deleted ${data.weddingName}. Guests, co-hosts and vendors can no longer see it.`;
  const window = `Any owner, you included, can restore it for ${days}: until ${data.restoreUntil}. Restoring puts everything back as it was.`;
  const after = `After that we erase the wedding and everything in it, the guest list and replies included. We cannot get it back once it is erased.`;
  const how = `To keep it, sign in to the organiser portal and restore it from Recently deleted on your weddings list.`;

  const text = [
    `Hello,`,
    ``,
    lead,
    ``,
    window,
    ``,
    after,
    ``,
    `${how} ${data.portalUrl}`,
    ``,
    `Cire Weddings`,
  ].join("\n");

  const html = wrap(
    `<h2>${esc(subject)}</h2>` +
      `<p>Hello,</p>` +
      `<p>${esc(lead)}</p>` +
      `<p>${esc(window)}</p>` +
      `<p>${esc(after)}</p>` +
      `<p>${esc(how)}</p>` +
      `<p><a href="${esc(data.portalUrl)}">Open the organiser portal</a></p>` +
      `<p style="color:#666;font-size:14px">Cire Weddings</p>`,
  );

  return { subject, text, html };
}
