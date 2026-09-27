/**
 * RSVP change digest email template.
 *
 * Sent by cire's daily cron to a wedding's owner and editor co-hosts on a day
 * when guests changed their RSVPs, and only then. It says how many households
 * made each kind of change since the recipient's last digest, and links to the
 * organiser portal's RSVP page, where the names are.
 *
 * Counts only, by design: no household name, no guest name, no attendance
 * status, no dietary note. Those are the couple's guests' data, and keeping
 * them in the portal keeps them off the mail provider.
 */

import type { RenderedEmail } from "./index";

/** The change kinds cire's RSVP change log records. */
export type RsvpDigestChangeKind =
  | "reply_new"
  | "reply_edited"
  | "plus_one_added"
  | "plus_one_renamed"
  | "plus_one_removed";

export interface RsvpChangeDigestData {
  /** The wedding as the couple named it, e.g. "Ama & Jonah". */
  readonly weddingName: string;
  /** Households with any change in this digest. */
  readonly households: number;
  /** Households per kind of change. A kind left out, or 0, is not mentioned. */
  readonly counts: Partial<Readonly<Record<RsvpDigestChangeKind, number>>>;
  /** The organiser portal's RSVP page for this wedding. */
  readonly rsvpUrl: string;
}

/** Each kind's line, in the order the email lists them. */
const LINES: readonly [RsvpDigestChangeKind, (n: number) => string][] = [
  ["reply_new", (n) => `${households(n)} replied`],
  ["reply_edited", (n) => `${households(n)} changed their reply`],
  ["plus_one_added", (n) => `${households(n)} added a plus-one`],
  ["plus_one_renamed", (n) => `${households(n)} changed their plus-one's name`],
  ["plus_one_removed", (n) => `${households(n)} removed their plus-one`],
];

function households(n: number): string {
  return `${n} ${n === 1 ? "household" : "households"}`;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

export function renderRsvpChangeDigest(data: RsvpChangeDigestData): RenderedEmail {
  // A line break in a subject header would start a new header.
  const subject = `RSVP changes for ${data.weddingName}`.replaceAll(/[\r\n]+/g, " ");
  const lines = LINES.flatMap(([kind, line]) => {
    const n = data.counts[kind] ?? 0;
    return n > 0 ? [line(n)] : [];
  });
  const lead = `${households(data.households)} changed their RSVPs for ${data.weddingName} since our last email`;
  const stop =
    'We send this once a day, and only when something has changed. To stop these emails for this wedding, turn off "Email me a daily summary" on the wedding\'s Overview page. Your co-hosts choose for themselves.';

  const text = [
    `Hello,`,
    ``,
    `${lead}:`,
    ``,
    ...lines.map((line) => `  ${line}`),
    ``,
    `See who: ${data.rsvpUrl}`,
    ``,
    stop,
    ``,
    `Cire Weddings`,
  ].join("\n");

  const html = wrap(
    `<h2>RSVP changes for ${esc(data.weddingName)}</h2>` +
      `<p>Hello,</p>` +
      `<p>${esc(lead)}:</p>` +
      `<ul>${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` +
      `<p><a href="${esc(data.rsvpUrl)}">See who</a></p>` +
      `<p style="color:#666;font-size:14px">${esc(stop)}</p>` +
      `<p style="color:#666;font-size:14px">Cire Weddings</p>`,
  );

  return { subject, text, html };
}
