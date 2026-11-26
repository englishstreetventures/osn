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
import { noneAttestation, type CreationOptions } from "./soft-authenticator";

/** `/verify/<request id>#<link secret>`, as any emailed link carries it. */
const LINK_RE = /\/verify\/((?:signup|recovery|stepup|emailchange)_[a-f0-9]{12})#([a-f0-9]{64})/;

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
  readonly retireSecret: string;
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
    previous?: { requestId: string; retireSecret: string };
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

/** The `Cookie` header the `Set-Cookie` lines `lines` would leave in a browser. */
export function cookieHeader(lines: readonly string[]): string {
  return lines.map((line) => line.split(";")[0]!).join("; ");
}

/** The test config's origin and RP ID, which the soft authenticator answers for. */
const TEST_ORIGIN = "http://localhost:5173";

/**
 * Enrols a first passkey for the session a sign-up handed over, through
 * `/passkey/register/*` with a software authenticator, which lifts the
 * session's restriction, then renews it at `/token` as the browser does.
 * Answers the ordinary session: its access token and the `Set-Cookie` lines
 * of the renewal (or the ones it was given, when the renewal set none).
 */
export async function enrolFirstPasskeyThroughRoutes(
  app: App,
  held: { profileId: string; accessToken: string; cookies: readonly string[] },
  options: { origin?: string | readonly string[]; headers?: Record<string, string> } = {},
): Promise<{ accessToken: string; cookies: string[] }> {
  // The held session's own cookie, whatever else the caller's headers carry.
  const headers = {
    ...options.headers,
    "Content-Type": "application/json",
    Authorization: `Bearer ${held.accessToken}`,
    cookie: cookieHeader(held.cookies),
  };
  const begun = await app.handle(
    new Request("http://localhost/passkey/register/begin", {
      method: "POST",
      headers,
      body: JSON.stringify({ profileId: held.profileId }),
    }),
  );
  if (begun.status !== 200) throw new Error(`passkey begin answered ${begun.status}`);
  const attestation = await noneAttestation(
    (await begun.json()) as CreationOptions,
    options.origin ?? TEST_ORIGIN,
  );
  const completed = await settledHandle(
    app,
    new Request("http://localhost/passkey/register/complete", {
      method: "POST",
      headers,
      body: JSON.stringify({ profileId: held.profileId, attestation }),
    }),
  );
  if (completed.status !== 200) throw new Error(`passkey complete answered ${completed.status}`);
  const granted = await app.handle(
    new Request("http://localhost/token", {
      method: "POST",
      headers: { ...options.headers, "Content-Type": "application/json", cookie: headers.cookie },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    }),
  );
  if (granted.status !== 200) throw new Error(`token answered ${granted.status}`);
  const renewed = granted.headers.getSetCookie();
  return {
    accessToken: ((await granted.json()) as { access_token: string }).access_token,
    cookies: renewed.length > 0 ? renewed : [...held.cookies],
  };
}

/**
 * The whole sign-up over the routes, then its first passkey, as a person who
 * finishes it does. Returns the completing status answer's body, and the
 * ordinary session the passkey earns: its access token, and the `Set-Cookie`
 * lines that hold it (`cookie`, the `Cookie` header they make). The status
 * answer's own session is restricted until the passkey is in; a test about
 * that session reads it through `registeredResponse`.
 */
export async function registerThroughRoutes(
  app: App,
  recorded: () => readonly RecordedEmail[],
  email: string,
  handle: string,
  options: {
    displayName?: string;
    headers?: Record<string, string>;
    origin?: string | readonly string[];
  } = {},
): Promise<{
  accessToken: string;
  profileId: string;
  cookies: string[];
  cookie: string;
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
  const enrolled = await enrolFirstPasskeyThroughRoutes(
    app,
    {
      profileId: body.profileId,
      accessToken: body.session.access_token,
      cookies: done.headers.getSetCookie(),
    },
    { origin: options.origin, headers: options.headers },
  );
  return {
    accessToken: enrolled.accessToken,
    profileId: body.profileId,
    cookies: enrolled.cookies,
    cookie: cookieHeader(enrolled.cookies),
    body,
  };
}

type AuthService = ReturnType<typeof createAuthService>;

/**
 * The whole sign-up through the service: begin (waiting for its send), the
 * newest link mailed to the address, confirm, claim, then the first passkey
 * through a software authenticator and a renewal, so the session it answers
 * is an ordinary one (`restricted: true` stops at the claim). Fails the
 * effect when any step does not land where a person's would.
 */
export const registerThroughService = (
  auth: AuthService,
  recorded: () => readonly RecordedEmail[],
  email: string,
  handle: string,
  options: {
    displayName?: string;
    sessionMeta?: SessionMeta;
    origin?: string | readonly string[];
    /** The status answer as it is, its session still restricted, with no passkey added. */
    restricted?: boolean;
  } = {},
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
    if (options.restricted) return done;
    // The first passkey, as the person adds it, so the session is ordinary.
    const accountId = (yield* auth.findProfileById(done.profileId))?.accountId;
    if (!accountId) return yield* Effect.die(new Error("no account for the new profile"));
    const sessionHash = auth.hashSessionToken(done.refreshToken);
    const { options: creation } = yield* auth.beginPasskeyRegistration(accountId, undefined, {
      recoverySessionHash: sessionHash,
    });
    const attestation = yield* Effect.promise(() =>
      noneAttestation(creation as CreationOptions, options.origin ?? TEST_ORIGIN),
    );
    yield* settle(
      auth.completePasskeyRegistration(
        accountId,
        attestation as never,
        sessionHash,
        options.sessionMeta,
      ),
    );
    const renewed = yield* auth.refreshTokens(done.refreshToken);
    return { ...done, ...renewed };
  });
