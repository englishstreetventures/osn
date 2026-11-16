/**
 * Account-deletion emails, sent by osn-api to an account holder.
 *
 * - `account-deletion-scheduled`: the deletion was asked for. The date it runs,
 *   how to keep the account before then, how to download the data, and what
 *   happens to what the person has in each app, as the server's own preview
 *   described it when the request was made.
 * - `account-deletion-cancelled`: the deletion was cancelled.
 * - `account-deleted`: the account is gone. The handles held and until when,
 *   what each app reported it keeps, and where each organisation went.
 * - `organisation-ownership-received`: an organisation passed to the reader,
 *   with a way to decline it.
 * - `account-data-link`: a link to the page that downloads the data. Never
 *   the data itself.
 *
 * Every one of them may carry text someone other than the reader wrote, such
 * as an app's label or a wedding's name. That text is escaped in the HTML part
 * and never reaches a subject. An organisation is named by its handle alone,
 * never by its free-text name: any of its admins can rewrite the name, and a
 * mail client turns a URL in it into a link.
 *
 * Each names the identity instance it comes from (`instanceName`), which the
 * sender passes in: this package names no product of its own.
 */

import { emailButton } from "./button";
import type { RenderedEmail } from "./index";

/** One line of what the deletion does outside the account itself. */
export interface DeletionPlanLine {
  /** What the person has, as the app or osn-api labelled it. */
  readonly label: string;
  /** What happens to it, as the chosen choice's description says; empty for an item shown for information. */
  readonly outcome: string;
  /** Unix seconds when anything kept is erased; null when nothing is kept. */
  readonly keptUntil: number | null;
}

export interface AccountDeletionScheduledData {
  readonly instanceName: string;
  /** Unix seconds: when the account is deleted, and the last moment to keep it. */
  readonly deletesAt: number;
  /** The app where the person signs in to keep the account or download their data. */
  readonly appUrl: string;
  /** The person chose to delete everything, rather than answer each item. */
  readonly deleteEverything: boolean;
  readonly plan: ReadonlyArray<DeletionPlanLine>;
}

export interface AccountDeletionCancelledData {
  readonly instanceName: string;
  readonly appUrl: string;
}

/** One thing an app reported it keeps after the account is gone. */
export interface KeptAfterDeletion {
  /** The app's name as people know it, e.g. "Pulse". */
  readonly app: string;
  readonly what: string;
  /** Unix seconds, or null when the app gave no date. */
  readonly erasedOn: number | null;
  /** Where to ask about it, or null. */
  readonly requestUrl: string | null;
}

/** An organisation the account owned, and who owns it now. */
export interface OrganisationAfterDeletion {
  /** The organisation's handle. Its name is free text its admins wrote, and is left out. */
  readonly handle: string;
  /** The new owner's handle; null when the organisation was deleted. */
  readonly newOwnerHandle: string | null;
}

export interface AccountDeletedData {
  readonly instanceName: string;
  /** The handles the account's profiles had, now held. */
  readonly handles: ReadonlyArray<string>;
  /** Unix seconds: when the held handles are released. */
  readonly handlesHeldUntil: number;
  readonly kept: ReadonlyArray<KeptAfterDeletion>;
  readonly organisations: ReadonlyArray<OrganisationAfterDeletion>;
}

export interface OrganisationOwnershipReceivedData {
  readonly instanceName: string;
  /** The organisation's handle. Its name is free text its members wrote, and is left out. */
  readonly organisationHandle: string;
  /** The organisation's page, where the reader can decline it. */
  readonly declineUrl: string;
  /** Unix seconds: the last moment the reader can decline it. */
  readonly declineUntil: number;
  /** Why it passed to the reader: its owner deleted their account, or the one before declined it. */
  readonly cause: "owner_deleted" | "owner_declined";
}

export interface AccountDataLinkData {
  readonly instanceName: string;
  /** The page that downloads the data once the reader has signed in. */
  readonly url: string;
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

/** The button, then the link as text for a client that drops its styles. */
const button = (url: string, label: string): string =>
  `${emailButton(url, label)}<p style="color:#666;word-break:break-all">${esc(url)}</p>`;

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

/** "23 November 2026": the date in UTC, as every reader reads the same. */
const utcDate = (unixSeconds: number): string => {
  const at = new Date(unixSeconds * 1_000);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
};

/** "23 November 2026 at 14:05 UTC". The sender cannot know the reader's time zone. */
const utcDateTime = (unixSeconds: number): string => {
  const at = new Date(unixSeconds * 1_000);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${utcDate(unixSeconds)} at ${hh}:${mm} UTC`;
};

const keptSentence = (keptUntil: number | null): string =>
  keptUntil === null ? "" : ` Kept until ${utcDate(keptUntil)}.`;

export function renderAccountDeletionScheduled(data: AccountDeletionScheduledData): RenderedEmail {
  const name = data.instanceName;
  const when = utcDateTime(data.deletesAt);
  const intro = `You asked to delete your ${name} account. It will be deleted on ${when}.`;
  const keep = `To keep it, sign in to ${name} before then and choose "Keep my account". Sign in with a passkey or with this email address: your handle won't find the account until you keep it. Your handles and profiles come back as they were.`;
  const download = `To take a copy of your data first, sign in the same way and choose "Download my data". After ${when} there is nothing left to download.`;
  const everything = data.deleteEverything
    ? "You chose to delete everything: each app deletes what you have there as soon as it can, and an organisation you own still passes to another member where there is one."
    : null;
  const planIntro =
    data.plan.length === 0
      ? "Nothing else needed an answer before your account could be deleted."
      : "What happens to what you have elsewhere:";
  const planText = data.plan
    .map((line) => {
      const what = `${line.outcome}${keptSentence(line.keptUntil)}`.trim();
      return what.length === 0 ? `- ${line.label}` : `- ${line.label}\n  ${what}`;
    })
    .join("\n");
  const notYou = `If you didn't ask for this, sign in now, keep your account, and check the devices signed in to it.`;

  const text = [
    intro,
    `${keep}\n\n${data.appUrl}`,
    download,
    ...(everything ? [everything] : []),
    data.plan.length === 0 ? planIntro : `${planIntro}\n${planText}`,
    notYou,
  ].join("\n\n");

  const planHtml =
    data.plan.length === 0
      ? ""
      : `<ul>${data.plan
          .map(
            (line) =>
              `<li><p style="margin:0">${esc(line.label)}</p><p style="margin:4px 0 12px;color:#444">${esc(`${line.outcome}${keptSentence(line.keptUntil)}`.trim())}</p></li>`,
          )
          .join("")}</ul>`;
  const html = wrap(
    `<h2>Your ${esc(name)} account will be deleted</h2><p>${esc(intro)}</p><p>${esc(keep)}</p>${button(data.appUrl, `Open ${name}`)}<p>${esc(download)}</p>${everything ? `<p>${esc(everything)}</p>` : ""}<p>${esc(planIntro)}</p>${planHtml}<p style="color:#666">${esc(notYou)}</p>`,
  );
  return { subject: `Your ${name} account is scheduled for deletion`, text, html };
}

export function renderAccountDeletionCancelled(data: AccountDeletionCancelledData): RenderedEmail {
  const name = data.instanceName;
  const lead = `Your ${name} account is no longer scheduled for deletion. Your handles and profiles are back as they were.`;
  const apps = `Apps that signed you out when you asked to delete it will ask you to sign in again.`;
  const notYou = `If you didn't do this, someone signed in to your account kept it. Sign in, check the devices signed in to it, and change what you need to.`;
  const text = [lead, apps, `${notYou}\n\n${data.appUrl}`].join("\n\n");
  const html = wrap(
    `<h2>Your ${esc(name)} account will not be deleted</h2><p>${esc(lead)}</p><p>${esc(apps)}</p><p style="color:#666">${esc(notYou)}</p>${button(data.appUrl, `Open ${name}`)}`,
  );
  return { subject: `Your ${name} account will not be deleted`, text, html };
}

const organisationLine = (org: OrganisationAfterDeletion): string =>
  org.newOwnerHandle === null
    ? `@${org.handle} was deleted.`
    : `@${org.handle} now belongs to @${org.newOwnerHandle}.`;

const keptLine = (item: KeptAfterDeletion): string => {
  const until = item.erasedOn === null ? "" : ` Kept until ${utcDate(item.erasedOn)}.`;
  const ask = item.requestUrl === null ? "" : ` To ask about it: ${item.requestUrl}`;
  return `${item.app}: ${item.what}${until}${ask}`;
};

export function renderAccountDeleted(data: AccountDeletedData): RenderedEmail {
  const name = data.instanceName;
  const lead = `Your ${name} account and its profiles have been deleted. They cannot be brought back.`;
  const handles =
    data.handles.length === 0
      ? null
      : `Your ${data.handles.length === 1 ? "handle" : "handles"} ${data.handles.map((h) => `@${h}`).join(", ")} ${data.handles.length === 1 ? "is" : "are"} held until ${utcDate(data.handlesHeldUntil)}. Nobody can take ${data.handles.length === 1 ? "it" : "them"} before then, you included. You can make a new account with this email address at any time.`;
  const organisations =
    data.organisations.length === 0
      ? null
      : `Organisations you owned:\n${data.organisations.map((org) => `- ${organisationLine(org)}`).join("\n")}`;
  const kept =
    data.kept.length === 0
      ? "No app kept anything of yours."
      : `What apps keep, and until when:\n${data.kept.map((item) => `- ${keptLine(item)}`).join("\n")}`;

  const text = [
    lead,
    ...(handles ? [handles] : []),
    ...(organisations ? [organisations] : []),
    kept,
  ].join("\n\n");

  const listHtml = (lines: ReadonlyArray<string>) =>
    `<ul>${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
  const html = wrap(
    `<h2>Your ${esc(name)} account has been deleted</h2><p>${esc(lead)}</p>${handles ? `<p>${esc(handles)}</p>` : ""}${
      data.organisations.length === 0
        ? ""
        : `<p>Organisations you owned:</p>${listHtml(data.organisations.map(organisationLine))}`
    }${
      data.kept.length === 0
        ? `<p>${esc(kept)}</p>`
        : `<p>What apps keep, and until when:</p>${listHtml(data.kept.map(keptLine))}`
    }`,
  );
  return { subject: `Your ${name} account has been deleted`, text, html };
}

export function renderOrganisationOwnershipReceived(
  data: OrganisationOwnershipReceivedData,
): RenderedEmail {
  const name = data.instanceName;
  const why =
    data.cause === "owner_deleted"
      ? "its owner deleted their account"
      : "the member it passed to before you declined it";
  const lead = `You now own @${data.organisationHandle} on ${name}, because ${why}.`;
  const until = utcDateTime(data.declineUntil);
  const decline = `If you don't want it, open its page and choose "Decline" before ${until}. It then passes to its next admin or member, or is deleted if there is none, and you leave it. After that date you can still delete it from its page.`;
  const text = [lead, `${decline}\n\n${data.declineUrl}`].join("\n\n");
  const html = wrap(
    `<h2>You now own an organisation on ${esc(name)}</h2><p>${esc(lead)}</p><p>${esc(decline)}</p>${button(data.declineUrl, "Open its page")}`,
  );
  return { subject: `You now own an organisation on ${name}`, text, html };
}

export function renderAccountDataLink(data: AccountDataLinkData): RenderedEmail {
  const name = data.instanceName;
  const lead = `You asked for a link to download your ${name} data. Open it, sign in if asked, confirm it's you, and choose "Download my data". You can download once a day.`;
  const none = `This email holds none of your data. If you didn't ask for it, ignore it: nobody can download your data without signing in to your account.`;
  const text = [lead, data.url, none].join("\n\n");
  const html = wrap(
    `<h2>Download your ${esc(name)} data</h2><p>${esc(lead)}</p>${button(data.url, "Download my data")}<p style="color:#666">${esc(none)}</p>`,
  );
  return { subject: `Download your ${name} data`, text, html };
}
