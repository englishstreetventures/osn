import type { PublicProfile } from "./tokens";

/**
 * Plain-fetch client for the OIDC consent screen (`/authorize` in @osn/social).
 *
 * The screen is handed nothing but an opaque request id — every OAuth
 * parameter stays parked server-side. These two calls read the request back
 * and post the user's answer:
 *
 *  1. `getContext(requestId)` — who is asking, for what, and whether this
 *     browser already holds a session.
 *  2. `submitDecision({ requestId, profileId, approved })` — the answer.
 *     Success returns an opaque `redirectTo` to assign verbatim.
 *
 * Both calls must ride the per-request binding cookie
 * (`__Host-osn_oar_<12hex>`, HttpOnly) the provider set on the redirect that
 * brought the user here, so both are `credentials: "include"` and must be
 * made same-site with the issuer. A missing binding cookie is answered
 * exactly like an unknown id: 404 `invalid_request`.
 */

export interface AuthorizeClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
  /**
   * How long either call may hang before it is aborted, in milliseconds.
   * Defaults to {@link DEFAULT_AUTHORIZE_TIMEOUT_MS}.
   *
   * Without a ceiling a stalled issuer leaves the consent screen on its
   * spinner until the browser's own (minutes-long, unspecified) timeout fires
   * — the retry screen only helps once the promise settles. Pass `0` to opt
   * out and rely on the caller's own `signal`.
   */
  timeoutMs?: number;
}

/**
 * 10s. Long enough to survive a slow mobile handshake on a cold cross-origin
 * landing, short enough that a hung issuer becomes a retry button rather than
 * an indefinite spinner.
 */
export const DEFAULT_AUTHORIZE_TIMEOUT_MS = 10_000;

/** Per-call options. Both calls accept a caller-owned abort signal. */
export interface AuthorizeCallOptions {
  /**
   * Aborted by the caller — e.g. the consent screen cancelling an in-flight
   * context read on unmount. Composed with the timeout, so whichever fires
   * first wins.
   */
  signal?: AbortSignal;
}

/** The error codes the consent screen has to branch on. */
export type AuthorizeErrorCode =
  /** Expired (10 min), consumed, or this browser lacks the binding cookie. Terminal. */
  | "invalid_request"
  /** The flow needs a session newer than the parked request. The request survives — re-auth, then retry the same id. */
  | "login_required"
  /** No session at all. First sign-in, then retry the same id. */
  | "unauthorized"
  /** Client disabled mid-flow. Terminal. */
  | "invalid_client"
  /** Rate limited. */
  | "rate_limited"
  /** Anything else, including a transport failure. */
  | "unknown";

export class AuthorizeError extends Error {
  readonly code: AuthorizeErrorCode;
  readonly status: number;

  constructor(code: AuthorizeErrorCode, status: number, message: string) {
    super(message);
    this.name = "AuthorizeError";
    this.code = code;
    this.status = status;
  }

  /** True when the parked request is dead and no retry can revive it. */
  get terminal(): boolean {
    return this.code === "invalid_request" || this.code === "invalid_client";
  }

  /** True when signing in and re-posting the same request id is the fix. */
  get needsSignIn(): boolean {
    return this.code === "login_required" || this.code === "unauthorized";
  }
}

export interface AuthorizeClientInfo {
  clientId: string;
  name: string;
  logoUrl: string | null;
  firstParty: boolean;
  /**
   * The host the authorization code will be delivered to for this request. A
   * verifiable identity signal shown next to the self-asserted `name`, so a
   * user can tell a genuine first-party app from a look-alike third party.
   */
  redirectDomain: string;
}

export interface AuthorizeContext {
  client: AuthorizeClientInfo;
  /** Requested scopes, already split. */
  scopes: string[];
  signedIn: boolean;
  /** Empty when signed out. */
  profiles: PublicProfile[];
  /** The profile this client already knows, if any — the default selection. */
  linkedProfileId: string | null;
}

export interface AuthorizeDecisionInput {
  requestId: string;
  profileId: string;
  approved: boolean;
}

export interface AuthorizeClient {
  /**
   * Read the parked request back. Call on load and again after any sign-in.
   * Throws `AuthorizeError` with code `invalid_request` when the request has
   * expired, been consumed, or was opened in a different browser.
   */
  getContext(requestId: string, options?: AuthorizeCallOptions): Promise<AuthorizeContext>;
  /**
   * Post the user's answer. A denial is a decision — Cancel posts
   * `approved: false` rather than abandoning the request for its TTL.
   * The returned `redirectTo` is opaque: assign it, never parse it.
   */
  submitDecision(
    input: AuthorizeDecisionInput,
    options?: AuthorizeCallOptions,
  ): Promise<{ redirectTo: string }>;
}

interface ErrorBody {
  error?: string;
  error_description?: string;
  message?: string;
}

const KNOWN_CODES: AuthorizeErrorCode[] = [
  "invalid_request",
  "login_required",
  "unauthorized",
  "invalid_client",
];

const toError = (status: number, body: ErrorBody): AuthorizeError => {
  if (status === 429) {
    return new AuthorizeError("rate_limited", status, "Too many attempts. Try again in a minute.");
  }
  const raw = body.error ?? "";
  const code = (KNOWN_CODES as string[]).includes(raw) ? (raw as AuthorizeErrorCode) : "unknown";
  const message = body.error_description ?? body.message ?? raw ?? `Request failed: ${status}`;
  return new AuthorizeError(
    code,
    status,
    message.length > 0 ? message : `Request failed: ${status}`,
  );
};

export function createAuthorizeClient(config: AuthorizeClientConfig): AuthorizeClient {
  const base = config.issuerUrl.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS;

  /**
   * One fetch under two deadlines: the caller's `signal` and our own timeout.
   * `AbortSignal.any` + `AbortSignal.timeout` would say this in one line, but
   * hand-rolling keeps the client working on the older mobile browsers that
   * still reach a consent screen — and it lets the timer be cleared, so a
   * settled call leaves nothing pending.
   *
   * A timeout is surfaced as an `AuthorizeError` the page can render and
   * retry; a caller abort is re-thrown untouched, because a component that
   * cancelled its own read does not want an error screen for it.
   */
  const send = async (
    url: string,
    init: RequestInit,
    options: AuthorizeCallOptions | undefined,
    /**
     * 0 disables the deadline for this call. Only the idempotent read opts in
     * — see the note on `submitDecision`.
     */
    callTimeoutMs: number,
  ): Promise<{ res: Response; json: unknown }> => {
    const caller = options?.signal;
    if (caller?.aborted) throw caller.reason;

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(caller!.reason);
    caller?.addEventListener("abort", onCallerAbort, { once: true });

    let timedOut = false;
    const timer =
      callTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, callTimeoutMs)
        : undefined;

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      // The body read is INSIDE the guarded window on purpose. `fetch` settles
      // when response HEADERS arrive, so clearing the deadline here would leave
      // a server that flushes headers and then stalls mid-body free to hang for
      // the browser's own multi-minute timeout — reintroducing exactly the
      // indefinite spinner this deadline exists to bound.
      try {
        return { res, json: await res.json() };
      } catch (cause) {
        // A malformed/empty body is not a failure — the status still classifies
        // the response. An ABORT mid-body is, so let that one through.
        if (controller.signal.aborted) throw cause;
        return { res, json: {} };
      }
    } catch (cause) {
      if (caller?.aborted) throw cause;
      if (timedOut) {
        throw new AuthorizeError("unknown", 0, "This is taking too long. Try again.");
      }
      // A transport failure is the "anything else" arm of AuthorizeErrorCode:
      // wrap it so every caller has one error type to branch on.
      throw new AuthorizeError("unknown", 0, "Could not reach OSN. Check your connection.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    }
  };

  const getContext = async (
    requestId: string,
    options?: AuthorizeCallOptions,
  ): Promise<AuthorizeContext> => {
    const { res, json: body } = await send(
      `${base}/authorize/context?request=${encodeURIComponent(requestId)}`,
      { method: "GET", credentials: "include", headers: { Accept: "application/json" } },
      options,
      timeoutMs,
    );
    const json = body as Partial<AuthorizeContext> & ErrorBody;
    if (!res.ok || !json.client || !Array.isArray(json.scopes)) {
      throw toError(res.status, json);
    }
    return {
      client: json.client,
      scopes: json.scopes,
      signedIn: json.signedIn === true,
      profiles: Array.isArray(json.profiles) ? json.profiles : [],
      linkedProfileId: json.linkedProfileId ?? null,
    };
  };

  const submitDecision = async (
    input: AuthorizeDecisionInput,
    options?: AuthorizeCallOptions,
  ): Promise<{ redirectTo: string }> => {
    const { res, json: body } = await send(
      `${base}/authorize/decision`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      options,
      // NO default deadline on this one, deliberately (S-M1).
      //
      // Aborting a fetch does not un-send the request. This POST is the
      // state-changing call: the server consumes the parked request, writes
      // the consent row and mints the code. A client-side timeout that fires
      // while the server is committing produces a RETRYABLE error, which
      // re-enables Allow/Cancel — so a user who then clicks Cancel is told the
      // request expired while a live consent grant sits in their Connected
      // apps. The read is safely retryable and is the call that actually
      // justified a deadline; presenting a non-idempotent write as retryable
      // is what manufactures the mismatch.
      //
      // A caller may still pass its own `signal` and accept that trade.
      0,
    );
    const json = body as { redirectTo?: string } & ErrorBody;
    if (!res.ok || typeof json.redirectTo !== "string") {
      throw toError(res.status, json);
    }
    return { redirectTo: json.redirectTo };
  };

  return { getContext, submitDecision };
}
