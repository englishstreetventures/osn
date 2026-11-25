/**
 * `change-notice`: tells an account holder that a page they agreed to — a
 * privacy notice, the terms — is changing, what changes, the day it takes
 * effect, and where to read it.
 *
 * Sent by osn-api's operator run to every account, once per notice. It is a
 * legal notice, not marketing: it carries nothing but the notice, and no
 * unsubscribe link or `List-Unsubscribe` header, because a person cannot opt
 * out of being told how their data is used or what they agreed to.
 *
 * The notice's words come from osn-api's reviewed registry, never from a
 * request; they are still escaped in the HTML part and kept off the subject's
 * line, as every template treats text it did not write. Nothing in it is
 * personal: every recipient of one notice gets the same message.
 *
 * It names the identity instance it comes from (`instanceName`), which the
 * sender passes in: this package names no product of its own.
 */

import { emailButton } from "./button";
import type { RenderedEmail } from "./index";

export interface ChangeNoticeData {
  readonly instanceName: string;
  /** What the page is called, lower case: "privacy notice", "terms". */
  readonly document: string;
  /** What changes, in plain words, one line each. */
  readonly changes: ReadonlyArray<string>;
  /** Unix seconds: the UTC midnight of the day the changes take effect. */
  readonly takesEffect: number;
  /** The page. */
  readonly url: string;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** One line: every run of whitespace, line breaks included, as one space. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "1 January 2027": the day in UTC, which is how `takesEffect` is written. */
const utcDate = (unixSeconds: number): string => {
  const at = new Date(unixSeconds * 1_000);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
};

export function renderChangeNotice(data: ChangeNoticeData): RenderedEmail {
  const name = oneLine(data.instanceName);
  const document = oneLine(data.document);
  const page = `${name} ${document}`;
  const day = utcDate(data.takesEffect);

  const subject = `Changes to the ${page}`;
  const intro = `We are changing the ${page}. The changes take effect on ${day}.`;
  const read = `Read the new ${document}:`;
  const why = `We send this to everyone with a ${name} account when the ${document} changes in a way that matters. It is not marketing, so there is nothing to unsubscribe from.`;
  const leave = `If you do not want to keep your account under the new ${document}, you can delete it in ${name} at any time.`;

  const text = [
    intro,
    `What changes:\n${data.changes.map((line) => `- ${line}`).join("\n")}`,
    `${read} ${data.url}`,
    why,
    leave,
  ].join("\n\n");

  const html = wrap(
    [
      `<h2>${esc(subject)}</h2>`,
      `<p>${esc(intro)}</p>`,
      `<p>What changes:</p>`,
      `<ul>${data.changes.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`,
      emailButton(data.url, `Read the ${document}`),
      `<p style="color:#666;word-break:break-all">${esc(data.url)}</p>`,
      `<p>${esc(why)}</p>`,
      `<p>${esc(leave)}</p>`,
    ].join(""),
  );

  return { subject, text, html };
}
