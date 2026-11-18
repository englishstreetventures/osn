/**
 * Email account recovery through the emailed link, the way a person does it:
 * begin from the tab that has lost its passkey, read the link out of the mail,
 * confirm it on any device by picking the number that tab shows, then claim
 * the restricted session from that tab. Tests that need a recovered account
 * drive this rather than a shortcut into the store.
 */

import type { RecordedEmail } from "@shared/email";
import { Effect } from "effect";

import type { createAuthService } from "../../src/services/auth";
import type { SessionMeta } from "../../src/services/auth/types";
import { settle, settledHandle } from "./background";
import { latestLinkTo, type EmailedLink } from "./registration";

type App = { handle(request: Request): Promise<Response> };

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

export interface BegunRecovery {
  readonly requestId: string;
  readonly claimSecret: string;
  readonly pairingCode: string;
  readonly expiresAt: number;
}

/** `POST /login/recovery/email/begin`, waiting for the send it forks. */
export async function beginRecoveryThroughRoutes(
  app: App,
  identifier: string,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: BegunRecovery }> {
  const res = await settledHandle(
    app,
    post("/login/recovery/email/begin", { identifier }, headers),
  );
  return { res, body: (await res.clone().json()) as BegunRecovery };
}

/** `POST /login/recovery/email/:requestId/status`, waiting for the work it forks. */
export function recoveryStatusThroughRoutes(
  app: App,
  requestId: string,
  claimSecret: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return settledHandle(
    app,
    post(`/login/recovery/email/${requestId}/status`, { claimSecret }, headers),
  );
}

/** `POST /login/recovery/email/:requestId/resend`, waiting for the send it forks. */
export function recoveryResendThroughRoutes(
  app: App,
  requestId: string,
  claimSecret: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return settledHandle(
    app,
    post(`/login/recovery/email/${requestId}/resend`, { claimSecret }, headers),
  );
}

/** The newest recovery link mailed to `to`, or null. */
export function latestRecoveryLinkTo(
  recorded: readonly RecordedEmail[],
  to: string,
): EmailedLink | null {
  const link = latestLinkTo(
    recorded.filter((mail) => mail.template === "link-recovery"),
    to,
  );
  return link;
}

/** How many recovery links have been mailed to `to`. */
export const recoveryLinksTo = (recorded: readonly RecordedEmail[], to: string): number =>
  recorded.filter((mail) => mail.template === "link-recovery" && mail.to === to).length;

/**
 * The whole recovery over the routes, answering the claiming status poll's
 * response: 201, the restricted session in its body and its cookie in
 * `Set-Cookie`. Throws when a step before it does not land where a person's
 * would.
 */
export async function recoveredResponse(
  app: App,
  recorded: () => readonly RecordedEmail[],
  email: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const before = recoveryLinksTo(recorded(), email);
  const { res, body: begun } = await beginRecoveryThroughRoutes(app, email, headers);
  if (res.status !== 202) throw new Error(`begin answered ${res.status}`);
  if (recoveryLinksTo(recorded(), email) !== before + 1) {
    throw new Error(`no recovery link mailed to ${email}`);
  }
  const link = latestRecoveryLinkTo(recorded(), email)!;
  const confirmed = await settledHandle(
    app,
    post(
      `/email-link/${link.requestId}/confirm`,
      { linkSecret: link.linkSecret, pairingPick: begun.pairingCode },
      headers,
    ),
  );
  if (confirmed.status !== 200) throw new Error(`confirm answered ${confirmed.status}`);
  return recoveryStatusThroughRoutes(app, begun.requestId, begun.claimSecret, headers);
}

type AuthService = ReturnType<typeof createAuthService>;

/**
 * The whole recovery through the service. Fails the effect when any step
 * before the claim does not land where a person's would, and answers the
 * claiming poll's result.
 */
export const recoverThroughService = (
  auth: AuthService,
  recorded: () => readonly RecordedEmail[],
  email: string,
  sessionMeta?: SessionMeta,
) =>
  Effect.gen(function* () {
    const before = recoveryLinksTo(recorded(), email);
    const begun = yield* settle(auth.beginEmailRecovery(email, sessionMeta));
    if (recoveryLinksTo(recorded(), email) !== before + 1) {
      return yield* Effect.die(new Error(`no recovery link mailed to ${email}`));
    }
    const link = latestRecoveryLinkTo(recorded(), email)!;
    const confirmed = yield* auth.confirmEmailLink(link.requestId, {
      linkSecret: link.linkSecret,
      pairingPick: begun.pairingCode,
    });
    if (confirmed !== "confirmed") return yield* Effect.die(new Error(`confirm: ${confirmed}`));
    return yield* settle(auth.emailRecoveryStatus(begun.requestId, begun.claimSecret, sessionMeta));
  });
