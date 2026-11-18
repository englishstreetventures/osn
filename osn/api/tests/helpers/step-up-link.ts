/**
 * Step-up and email change through the emailed link, the way a person does
 * them: begin from the signed-in tab, read the link out of the mail, confirm
 * it with the number that tab shows, then let the tab finish. Tests that need
 * a step-up token or a changed address drive this rather than a shortcut into
 * the store.
 */

import type { RecordedEmail } from "@shared/email";
import type { StepUpPurpose } from "@shared/observability/metrics";
import { Effect } from "effect";

import type { createAuthService } from "../../src/services/auth";
import { settle, settledHandle } from "./background";
import { linkIn, type EmailedLink } from "./registration";
import { mintingSession } from "./step-up-session";

type App = { handle(request: Request): Promise<Response> };
type AuthService = ReturnType<typeof createAuthService>;

const post = (
  path: string,
  body: unknown,
  accessToken?: string,
  headers: Record<string, string> = {},
) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** What a step-up or email-change begin answers the tab that began. */
export interface BegunLink {
  readonly requestId: string;
  readonly claimSecret: string;
  readonly pairingCode: string;
  readonly expiresAt: number;
}

/** The newest link mailed for request `requestId`, or null. */
export function linkForRequest(
  recorded: readonly RecordedEmail[],
  requestId: string,
): EmailedLink | null {
  for (let i = recorded.length - 1; i >= 0; i--) {
    const link = linkIn(recorded[i]!.text);
    if (link?.requestId === requestId) return link;
  }
  return null;
}

/** `POST /step-up/email/begin`, waiting for the send it forks. */
export async function beginStepUpThroughRoutes(
  app: App,
  accessToken: string,
  purpose: StepUpPurpose,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: BegunLink }> {
  const res = await settledHandle(
    app,
    post("/step-up/email/begin", { purpose }, accessToken, headers),
  );
  return { res, body: (await res.clone().json()) as BegunLink };
}

/** `POST /step-up/email/:requestId/status`. */
export function stepUpStatusThroughRoutes(
  app: App,
  accessToken: string,
  requestId: string,
  claimSecret: string,
): Promise<Response> {
  return settledHandle(
    app,
    post(`/step-up/email/${requestId}/status`, { claimSecret }, accessToken),
  );
}

/** `POST /email-link/:requestId/confirm`, as the link's page sends it. */
export function confirmLinkThroughRoutes(
  app: App,
  requestId: string,
  linkSecret: string,
  pairingPick: string,
): Promise<Response> {
  return settledHandle(app, post(`/email-link/${requestId}/confirm`, { linkSecret, pairingPick }));
}

/**
 * A step-up token for `purpose`, minted through the emailed link over the
 * routes. Throws when a step does not land where a person's would.
 */
export async function stepUpThroughRoutes(
  app: App,
  accessToken: string,
  recorded: () => readonly RecordedEmail[],
  purpose: StepUpPurpose,
): Promise<string> {
  const { res, body } = await beginStepUpThroughRoutes(app, accessToken, purpose);
  if (res.status !== 200) throw new Error(`step-up begin answered ${res.status}`);
  const link = linkForRequest(recorded(), body.requestId);
  if (!link) throw new Error("no step-up link mailed");
  const confirmed = await confirmLinkThroughRoutes(
    app,
    body.requestId,
    link.linkSecret,
    body.pairingCode,
  );
  if (confirmed.status !== 200) throw new Error(`confirm answered ${confirmed.status}`);
  const status = await stepUpStatusThroughRoutes(
    app,
    accessToken,
    body.requestId,
    body.claimSecret,
  );
  const json = (await status.json()) as { status?: string; step_up_token?: string };
  if (json.status !== "complete" || !json.step_up_token) {
    throw new Error(`step-up status answered ${JSON.stringify(json)}`);
  }
  return json.step_up_token;
}

/** The account's default profile id: the profile a signed-in caller acts as. */
export const profileOf = (auth: AuthService, accountId: string) =>
  Effect.gen(function* () {
    const profile = yield* auth.findDefaultProfile(accountId);
    if (!profile) return yield* Effect.die(new Error(`no profile for ${accountId}`));
    return profile.id;
  });

/**
 * A step-up token for `purpose`, minted through the emailed link over the
 * service, bound to a live session seeded for the purpose.
 */
export const stepUpThroughService = (
  auth: AuthService,
  accountId: string,
  purpose: StepUpPurpose,
  recorded: () => readonly RecordedEmail[],
) =>
  Effect.gen(function* () {
    const begun = yield* settle(auth.beginStepUpEmail(accountId, purpose));
    const link = linkForRequest(recorded(), begun.requestId);
    if (!link) return yield* Effect.die(new Error("no step-up link mailed"));
    const confirmed = yield* auth.confirmEmailLink(begun.requestId, {
      linkSecret: link.linkSecret,
      pairingPick: begun.pairingCode,
    });
    if (confirmed !== "confirmed") return yield* Effect.die(new Error(`confirm: ${confirmed}`));
    const profileId = yield* profileOf(auth, accountId);
    const status = yield* settle(
      auth.stepUpEmailStatus(
        yield* mintingSession(accountId),
        profileId,
        begun.requestId,
        begun.claimSecret,
      ),
    );
    if (status.status !== "complete") {
      return yield* Effect.die(new Error(`step-up status: ${status.status}`));
    }
    return status.stepUpToken;
  });

/** `POST /account/email/begin`, waiting for the send it forks. */
export async function beginEmailChangeThroughRoutes(
  app: App,
  accessToken: string,
  newEmail: string,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: BegunLink }> {
  const res = await settledHandle(
    app,
    post("/account/email/begin", { new_email: newEmail }, accessToken, headers),
  );
  return { res, body: (await res.clone().json()) as BegunLink };
}

/** `POST /account/email/:requestId/status`. */
export function emailChangeStatusThroughRoutes(
  app: App,
  accessToken: string,
  requestId: string,
  claimSecret: string,
): Promise<Response> {
  return settledHandle(
    app,
    post(`/account/email/${requestId}/status`, { claimSecret }, accessToken),
  );
}

/** `POST /account/email/:requestId/complete`. */
export function completeEmailChangeThroughRoutes(
  app: App,
  accessToken: string,
  requestId: string,
  claimSecret: string,
  stepUpToken: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return settledHandle(
    app,
    post(
      `/account/email/${requestId}/complete`,
      { claimSecret, step_up_token: stepUpToken },
      accessToken,
      headers,
    ),
  );
}

/**
 * Begins an email change to `newEmail` over the service and confirms the
 * link mailed to it, leaving the request confirmed and unclaimed. Answers the
 * begin, for the complete that follows.
 */
export const confirmedEmailChange = (
  auth: AuthService,
  accountId: string,
  newEmail: string,
  recorded: () => readonly RecordedEmail[],
) =>
  Effect.gen(function* () {
    const begun = yield* settle(auth.beginEmailChange(accountId, newEmail));
    const link = linkForRequest(recorded(), begun.requestId);
    if (!link) return yield* Effect.die(new Error(`no email-change link mailed to ${newEmail}`));
    const confirmed = yield* auth.confirmEmailLink(begun.requestId, {
      linkSecret: link.linkSecret,
      pairingPick: begun.pairingCode,
    });
    if (confirmed !== "confirmed") return yield* Effect.die(new Error(`confirm: ${confirmed}`));
    return begun;
  });

/**
 * A session hash no session row holds. A test whose account has no session
 * passes it where an email change wants the caller's: the change's sweep
 * then spares nothing.
 */
export const NO_LIVE_SESSION = "0".repeat(64);

/**
 * The whole email change over the service: begin, confirm the new address's
 * link, complete with `stepUpToken`. Answers what the complete answers.
 */
export const changeEmailThroughService = (
  auth: AuthService,
  accountId: string,
  newEmail: string,
  stepUpToken: string,
  recorded: () => readonly RecordedEmail[],
  currentSessionHash: string = NO_LIVE_SESSION,
) =>
  Effect.gen(function* () {
    const begun = yield* confirmedEmailChange(auth, accountId, newEmail, recorded);
    return yield* auth.completeEmailChange(
      accountId,
      yield* profileOf(auth, accountId),
      begun.requestId,
      begun.claimSecret,
      stepUpToken,
      currentSessionHash,
    );
  });
