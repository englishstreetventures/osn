/**
 * Operator alert: cire's R2 orphan reconciler is holding, has resumed, or is
 * stopped.
 *
 * The daily cron sends one per bucket per run while a reconciler is held or
 * stopped, one when a hold ends, and one a run while a whole tier has the
 * reconcilers disabled. It carries counts, a bucket name and commands, never an
 * object key or guest data: the address is an operator's, and the runbook
 * (`wiki/compliance/backup-dr.md`) holds the rest.
 */

import type { RenderedEmail } from "./index";

/** Which deployment sent it; dev alerts say so in the subject. */
type AlertTier = "dev" | "production";

export type R2ReconcileAlertData =
  | {
      /** A run deleted nothing because the referencing rows fell by more than half. */
      readonly kind: "held";
      readonly env: AlertTier;
      /** The R2 bucket's name in this tier, e.g. `cire-sheets`. */
      readonly bucket: string;
      readonly referencingRows: number;
      /** The count before the drop, which the hold compares against. */
      readonly previousRows: number;
      /** Runs held so far, this one included. */
      readonly heldRuns: number;
      /** Held runs left before deleting resumes on its own. */
      readonly runsLeft: number;
    }
  | {
      /** The hold reached its limit; this run accepted the lower count and deleted. */
      readonly kind: "released";
      readonly env: AlertTier;
      readonly bucket: string;
      readonly referencingRows: number;
      readonly previousRows: number;
    }
  | {
      /** `reconcile/stop` is in the bucket, so the run deleted nothing. */
      readonly kind: "stopped";
      readonly env: AlertTier;
      readonly bucket: string;
      /** Whole days since the stop object was written. */
      readonly stoppedDays: number;
    }
  | {
      /** `CIRE_R2_RECONCILE_DISABLED` keeps both reconcilers out of the cron. */
      readonly kind: "disabled";
      readonly env: AlertTier;
    };

/** The longest a stop object should stay in place; the runbook states it too. */
const STOP_LIMIT_DAYS = 14;

const RUNBOOK = "wiki/compliance/backup-dr.md";

const escapeHtml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const wrap = (bodyHtml: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0a0a0a;max-width:480px;margin:0 auto;padding:24px">${bodyHtml}</body></html>`;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A whole, non-negative number, so a stray fraction never reads as "1.5 runs". */
const whole = (n: number): number => Math.max(0, Math.trunc(n));

/** A bucket name as it may appear in a subject or a command: no spaces or line breaks. */
const bucketName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "");

const stopCommand = (bucket: string): string =>
  `printf 'restore\\n' | bunx wrangler r2 object put ${bucket}/reconcile/stop --pipe --remote`;
const liftCommand = (bucket: string): string =>
  `bunx wrangler r2 object delete ${bucket}/reconcile/stop --remote`;

interface Body {
  readonly subject: string;
  readonly lines: ReadonlyArray<string>;
  readonly command?: string;
}

function body(data: R2ReconcileAlertData): Body {
  switch (data.kind) {
    case "held": {
      const bucket = bucketName(data.bucket);
      const now = whole(data.referencingRows);
      const before = whole(data.previousRows);
      return {
        subject: `${bucket} orphan deletion held — referencing rows fell from ${before} to ${now}`,
        lines: [
          `The ${bucket} orphan reconciler deleted nothing: the rows naming its objects fell from ${before} to ${now}, more than half, so it has held for ${plural(whole(data.heldRuns), "run", "runs")}.`,
          `It holds for ${plural(whole(data.runsLeft), "more run", "more runs")} unless the count recovers, then resumes deleting. If the rows were lost by mistake or a database restore is under way, stop it now:`,
        ],
        command: stopCommand(bucket),
      };
    }
    case "released": {
      const bucket = bucketName(data.bucket);
      return {
        subject: `${bucket} orphan deletion resumed after its hold`,
        lines: [
          `The ${bucket} orphan reconciler held for as many runs as it may and has resumed deleting, accepting ${whole(data.referencingRows)} referencing rows in place of ${whole(data.previousRows)}.`,
          `To stop it again:`,
        ],
        command: stopCommand(bucket),
      };
    }
    case "stopped": {
      const bucket = bucketName(data.bucket);
      const days = whole(data.stoppedDays);
      return {
        subject: `${bucket} orphan deletion stopped for ${plural(days, "day", "days")}`,
        lines: [
          `reconcile/stop has been in ${bucket} for ${plural(days, "day", "days")}, so its orphan reconciler deletes nothing. A stop may stay at most ${STOP_LIMIT_DAYS} days: orphaned guest data is not removed while it is in place.`,
          `Lift it once the restore is finished:`,
        ],
        command: liftCommand(bucket),
      };
    }
    case "disabled":
      return {
        subject: `R2 orphan deletion disabled for this tier`,
        lines: [
          `CIRE_R2_RECONCILE_DISABLED in cire/api/wrangler.toml keeps both R2 orphan reconcilers out of the daily cron, so orphaned guest data is not removed.`,
          `Set it back to "false" in that tier's vars block and deploy once the reason has passed.`,
        ],
      };
  }
}

export function renderR2ReconcileAlert(data: R2ReconcileAlertData): RenderedEmail {
  const { subject, lines, command } = body(data);
  const footer = `The runbook is ${RUNBOOK}. This alert repeats on every daily run while the condition lasts.`;
  const text = [...lines.flatMap((l) => [l, ""]), ...(command ? [command, ""] : []), footer].join(
    "\n",
  );
  const html = wrap(
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
      (command
        ? `<pre style="background:#f4f4f5;padding:12px;border-radius:6px;overflow-x:auto">${escapeHtml(command)}</pre>`
        : "") +
      `<p style="color:#666;font-size:14px">The runbook is <code>${RUNBOOK}</code>. This alert repeats on every daily run while the condition lasts.</p>`,
  );
  return { subject: `Cire${data.env === "production" ? "" : " (dev)"}: ${subject}`, text, html };
}
