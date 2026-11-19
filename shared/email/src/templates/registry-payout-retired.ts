/**
 * Payout account retired notice.
 *
 * Sent to a wedding's owners when one of them retires the Stripe account the
 * wedding's money gifts are paid into: its holder hands money gifts to another
 * owner or disconnects it, or another owner replaces it. Guests cannot give
 * money until an owner connects an account, so each copy says so and links
 * the Money gifts panel. Each names who acted, so a retire made from a session
 * someone else is using reaches the real owner too.
 *
 * No guest data and no account details: the wedding's name, the people
 * involved (by the name and handle they chose on OSN), and a link to the
 * portal.
 */

import { emailButton } from "./button";
import type { RenderedEmail } from "./index";

/** By whose standing the account was retired. */
export type RegistryPayoutRetiredReason =
  /** Its holder retired it and named an owner to connect the next one. */
  | "handed_over"
  /** Its holder retired it and named no one. */
  | "disconnected"
  /** Another owner retired it while its holder was an owner. */
  | "replaced"
  /** An owner retired it while no current owner held it. */
  | "holder_absent";

/** Who this copy of the notice is for. */
export type RegistryPayoutRetiredAudience =
  /** The owner who retired it. */
  | "actor"
  /** The owner money gifts were handed to. */
  | "named"
  /** The owner whose account another owner replaced. */
  | "holder"
  /** Every other owner. */
  | "owner";

export interface RegistryPayoutRetiredData {
  /** The wedding as the couple named it, e.g. "Ama & Jonah". */
  readonly weddingName: string;
  /** Who retired it. `null` when OSN could not say. */
  readonly actorName: string | null;
  /** Whom money gifts were handed to, for `handed_over`. `null` otherwise, or when OSN could not say. */
  readonly namedName: string | null;
  /** Whose account was replaced, for `replaced`. `null` otherwise, or when OSN could not say. */
  readonly holderName: string | null;
  readonly reason: RegistryPayoutRetiredReason;
  readonly audience: RegistryPayoutRetiredAudience;
  /** The wedding's Money gifts panel in the organiser portal. */
  readonly moneyGiftsUrl: string;
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

/** What happened, worded for this copy's reader. */
function leadOf(data: RegistryPayoutRetiredData, wedding: string): string {
  const actor = data.actorName ?? "Another owner";
  const named = data.namedName ?? "another owner";
  const holder = data.holderName ?? "another owner";
  const you = data.audience === "actor";
  switch (data.reason) {
    case "handed_over":
      if (you) {
        return `You disconnected your Stripe account from ${wedding} and handed money gifts to ${named}.`;
      }
      return data.audience === "named"
        ? `${actor} disconnected their Stripe account from ${wedding} and handed money gifts to you.`
        : `${actor} disconnected their Stripe account from ${wedding} and handed money gifts to ${named}.`;
    case "disconnected":
      return you
        ? `You disconnected your Stripe account from ${wedding}.`
        : `${actor} disconnected their Stripe account from ${wedding}.`;
    case "replaced":
      if (you) return `You disconnected the Stripe account ${holder} connected to ${wedding}.`;
      return data.audience === "holder"
        ? `${actor} disconnected the Stripe account you connected to ${wedding}.`
        : `${actor} disconnected the Stripe account ${holder} connected to ${wedding}.`;
    case "holder_absent":
      return `${you ? "You" : actor} disconnected the Stripe account money gifts on ${wedding} were paid into. No current owner of the wedding had connected it.`;
  }
}

/** Whether this reader held the account just retired. */
const heldIt = (data: RegistryPayoutRetiredData): boolean =>
  (data.audience === "actor" &&
    (data.reason === "handed_over" || data.reason === "disconnected")) ||
  data.audience === "holder";

export function renderRegistryPayoutRetired(data: RegistryPayoutRetiredData): RenderedEmail {
  const wedding = oneLine(data.weddingName);
  const subject = oneLine(`The Stripe account for money gifts on ${wedding} was disconnected`);
  const lead = leadOf(data, wedding);
  const next =
    data.audience === "named"
      ? `Guests cannot give money until you connect a Stripe account. You can do it in Money gifts.`
      : `Guests cannot give money until an owner connects a Stripe account in Money gifts.`;
  const kept = heldIt(data)
    ? `Gifts already given stay in your Stripe account, and you handle any refund or dispute on them there.`
    : null;
  const advice =
    data.audience === "actor"
      ? `We send this to every owner, you included. If this was not you, someone else is signed in to your account: secure it, then sign in to the organiser portal and check Money gifts.`
      : `If you did not expect this, sign in to the organiser portal and check Money gifts.`;

  const text = [
    `Hello,`,
    ``,
    lead,
    ``,
    next,
    ...(kept ? [``, kept] : []),
    ``,
    advice,
    ``,
    `Money gifts: ${data.moneyGiftsUrl}`,
    ``,
    `Cire Weddings`,
  ].join("\n");

  const html = wrap(
    `<h2>${esc(subject)}</h2>` +
      `<p>Hello,</p>` +
      `<p>${esc(lead)}</p>` +
      `<p>${esc(next)}</p>` +
      (kept ? `<p>${esc(kept)}</p>` : "") +
      `<p>${esc(advice)}</p>` +
      emailButton(data.moneyGiftsUrl, "Open Money gifts") +
      `<p style="color:#666;font-size:14px">${esc(data.moneyGiftsUrl)}</p>` +
      `<p style="color:#666;font-size:14px">Cire Weddings</p>`,
  );

  return { subject, text, html };
}
