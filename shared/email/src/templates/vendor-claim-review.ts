/**
 * Operator reminder: vendor directory claims are waiting for review.
 *
 * Sent at most once a day, to the operator address the deployment configures,
 * while at least one redeemed claim waits. It carries counts only, never a
 * listing, claimant or contact detail: the operator reads those with the review
 * script, under their own Cloudflare login.
 */

import type { RenderedEmail } from "./index";

export interface VendorClaimReviewPendingData {
  /** Claims waiting for an operator. At least 1. */
  readonly pending: number;
  /** Whole days the oldest of them has waited. */
  readonly oldestWaitingDays: number;
  /** The review script's `--env` for the deployment that sent this. */
  readonly env: "dev" | "production";
}

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function renderVendorClaimReviewPending(data: VendorClaimReviewPendingData): RenderedEmail {
  // Numbers only reach the body, so there is nothing to escape; truncating
  // keeps a non-integer from rendering as "1.5 claims".
  const pending = Math.max(0, Math.trunc(data.pending));
  const days = Math.max(0, Math.trunc(data.oldestWaitingDays));
  const count = plural(pending, "vendor claim is", "vendor claims are");
  const age =
    days === 0
      ? "The oldest arrived today."
      : `The oldest has waited ${plural(days, "day", "days")}.`;
  const listCommand = `bun scripts/cire-vendor-claim-review.ts list --env ${data.env === "production" ? "production" : "dev"}`;
  const subject = `Cire${data.env === "production" ? "" : " (dev)"}: ${count} waiting for review`;
  const text = [
    `${count} waiting for an operator. ${age}`,
    ``,
    `Each listing stays unowned and in draft, and its couples' enquiries stay buffered, until you confirm or reject the claim. List them with:`,
    ``,
    listCommand,
    ``,
    `The runbook is wiki/cire/cire-vendors.md, "Operator review of claims". This reminder repeats daily while any claim waits.`,
  ].join("\n");
  const html = wrap(
    `<p>${count} waiting for an operator. ${age}</p>` +
      `<p>Each listing stays unowned and in draft, and its couples' enquiries stay buffered, until you confirm or reject the claim. List them with:</p>` +
      `<pre style="background:#f4f4f5;padding:12px;border-radius:6px;overflow-x:auto">${listCommand}</pre>` +
      `<p style="color:#666;font-size:14px">The runbook is <code>wiki/cire/cire-vendors.md</code>, "Operator review of claims". This reminder repeats daily while any claim waits.</p>`,
  );
  return { subject, text, html };
}
