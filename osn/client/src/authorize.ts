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
  getContext(requestId: string): Promise<AuthorizeContext>;
  /**
   * Post the user's answer. A denial is a decision — Cancel posts
   * `approved: false` rather than abandoning the request for its TTL.
   * The returned `redirectTo` is opaque: assign it, never parse it.
   */
  submitDecision(input: AuthorizeDecisionInput): Promise<{ redirectTo: string }>;
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

const readBody = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return {};
  }
};

export function createAuthorizeClient(config: AuthorizeClientConfig): AuthorizeClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const getContext = async (requestId: string): Promise<AuthorizeContext> => {
    const res = await fetch(`${base}/authorize/context?request=${encodeURIComponent(requestId)}`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const json = (await readBody(res)) as Partial<AuthorizeContext> & ErrorBody;
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

  const submitDecision = async (input: AuthorizeDecisionInput): Promise<{ redirectTo: string }> => {
    const res = await fetch(`${base}/authorize/decision`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const json = (await readBody(res)) as { redirectTo?: string } & ErrorBody;
    if (!res.ok || typeof json.redirectTo !== "string") {
      throw toError(res.status, json);
    }
    return { redirectTo: json.redirectTo };
  };

  return { getContext, submitDecision };
}
