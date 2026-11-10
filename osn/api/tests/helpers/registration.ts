/**
 * Sign-up through the emailed link, the way a person does it: begin, read the
 * link out of the mail, confirm it by picking the number the tab that began
 * shows, then claim the account from that tab. Tests that need an account but
 * do not test sign-up register through these, so they drive the real flow
 * rather than a shortcut into the store.
 */

import type { RecordedEmail } from "@shared/email";
import { Effect } from "effect";

import type { createAuthService } from "../../src/services/auth";
import type { SessionMeta } from "../../src/services/auth/types";
import { settle, settledHandle } from "./background";

/** `/verify/<request id>#<link secret>`, as the sign-up email carries it. */
const LINK_RE = /\/verify\/(signup_[a-f0-9]{12})#([a-f0-9]{64})/;

export interface EmailedLink {
  readonly url: string;
  readonly requestId: string;
  readonly linkSecret: string;
}

/** The link in one email's text, or null. */
export function linkIn(text: string): EmailedLink | null {
  const match = LINK_RE.exec(text);
  if (!match) return null;
  const url = text.slice(text.lastIndexOf("http", match.index), match.index + match[0].length);
  return { url, requestId: match[1]!, linkSecret: match[2]! };
}

/** The newest link mailed to `to`, or null when none was. */
export function latestLinkTo(recorded: readonly RecordedEmail[], to: string): EmailedLink | null {
  for (let i = recorded.length - 1; i >= 0; i--) {
    const mail = recorded[i]!;
    if (mail.to !== to) continue;
    const link = linkIn(mail.text);
    if (link) return link;
  }
  return null;
}

/** Every link mailed to `to`, oldest first. */
export function linksTo(recorded: readonly RecordedEmail[], to: string): EmailedLink[] {
  return recorded
    .filter((mail) => mail.to === to)
    .map((mail) => linkIn(mail.text))
    .filter((link): link is EmailedLink => link !== null);
}

type App = { handle(request: Request): Promise<Response> };

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

export interface BegunSignUp {
  readonly requestId: string;
  readonly claimSecret: string;
  readonly pairingCode: string;
  readonly expiresAt: number;
}

/** `POST /register/begin`, waiting for the send it forks. */
export async function beginThroughRoutes(
  app: App,
  input: {
    email: string;
    handle: string;
    birthdate?: string;
    displayName?: string;
    previous?: { requestId: string; claimSecret: string };
    turnstileToken?: string;
    emailVerificationToken?: string;
    nonceSecret?: string;
  },
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: BegunSignUp }> {
  const res = await settledHandle(
    app,
    post("/register/begin", { birthdate: "1990-01-01", ...input }, headers),
  );
  return { res, body: (await res.clone().json()) as BegunSignUp };
}

/** `POST /email-link/:requestId/confirm` with the reader's pick. */
export function confirmThroughRoutes(
  app: App,
  requestId: string,
  linkSecret: string,
  pairingPick: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return settledHandle(
    app,
    post(`/email-link/${requestId}/confirm`, { linkSecret, pairingPick }, headers),
  );
}

/** `POST /email-link/:requestId/candidates`. */
export function candidatesThroughRoutes(
  app: App,
  requestId: string,
  linkSecret: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(post(`/email-link/${requestId}/candidates`, { linkSecret }, headers));
}

/** `POST /register/:requestId/status`, waiting for the cleanup it forks. */
export function statusThroughRoutes(
  app: App,
  requestId: string,
  claimSecret: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return settledHandle(app, post(`/register/${requestId}/status`, { claimSecret }, headers));
}

/** `POST /register/:requestId/resend`, waiting for the send it forks. */
export function resendThroughRoutes(
  app: App,
  requestId: string,
  claimSecret: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return settledHandle(app, post(`/register/${requestId}/resend`, { claimSecret }, headers));
}

/**
 * The whole sign-up over the routes, answering the completing status poll's
 * response: 201, the session in its body and its cookies in `Set-Cookie`.
 * Throws when a step before it does not land where a person's would.
 */
export async function registeredResponse(
  app: App,
  recorded: () => readonly RecordedEmail[],
  email: string,
  handle: string,
  options: { displayName?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = options.headers ?? {};
  const { body: begun } = await beginThroughRoutes(
    app,
    { email, handle, displayName: options.displayName },
    headers,
  );
  const link = latestLinkTo(recorded(), email.toLowerCase());
  if (!link) throw new Error(`no sign-up link mailed to ${email}`);
  const confirmed = await confirmThroughRoutes(
    app,
    link.requestId,
    link.linkSecret,
    begun.pairingCode,
    headers,
  );
  if (confirmed.status !== 200) throw new Error(`confirm answered ${confirmed.status}`);
  return statusThroughRoutes(app, begun.requestId, begun.claimSecret, headers);
}

/**
 * The whole sign-up over the routes. Returns the completing status answer's
 * body, its access token, and the `Set-Cookie` lines it carried.
 */
export async function registerThroughRoutes(
  app: App,
  recorded: () => readonly RecordedEmail[],
  email: string,
  handle: string,
  options: { displayName?: string; headers?: Record<string, string> } = {},
): Promise<{
  accessToken: string;
  profileId: string;
  cookies: string[];
  body: { profileId: string; handle: string; email: string; session: { access_token: string } };
}> {
  const done = await registeredResponse(app, recorded, email, handle, options);
  if (done.status !== 201) throw new Error(`status answered ${done.status}`);
  const body = (await done.json()) as {
    profileId: string;
    handle: string;
    email: string;
    session: { access_token: string };
  };
  return {
    accessToken: body.session.access_token,
    profileId: body.profileId,
    cookies: done.headers.getSetCookie(),
    body,
  };
}

type AuthService = ReturnType<typeof createAuthService>;

/**
 * The whole sign-up through the service: begin (waiting for its send), the
 * newest link mailed to the address, confirm, claim. Fails the effect when any
 * step does not land where a person's would.
 */
export const registerThroughService = (
  auth: AuthService,
  recorded: () => readonly RecordedEmail[],
  email: string,
  handle: string,
  options: { displayName?: string; sessionMeta?: SessionMeta } = {},
) =>
  Effect.gen(function* () {
    const begun = yield* settle(
      auth.beginRegistration(email, handle, "1990-01-01", options.displayName),
    );
    const link = latestLinkTo(recorded(), email.toLowerCase());
    if (!link) return yield* Effect.die(new Error(`no sign-up link mailed to ${email}`));
    const confirmed = yield* auth.confirmEmailLink(link.requestId, {
      linkSecret: link.linkSecret,
      pairingPick: begun.pairingCode,
    });
    if (confirmed !== "confirmed") return yield* Effect.die(new Error(`confirm: ${confirmed}`));
    const done = yield* settle(
      auth.registrationStatus(begun.requestId, begun.claimSecret, options.sessionMeta),
    );
    if (done.status !== "complete") return yield* Effect.die(new Error(`status: ${done.status}`));
    return done;
  });
