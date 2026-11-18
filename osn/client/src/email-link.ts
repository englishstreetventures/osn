/**
 * The calls the page an emailed link opens makes, shared by every flow that
 * emails a link. Unauthenticated, and no cookies: confirming never signs this
 * browser in — the tab that began the flow gets the result.
 *
 * Each call answers the way the confirm page needs: every refusal (an unknown
 * request, a wrong secret, a spent or expired one, a wrong pick, a refused
 * decline) is `expired`, which ends the page; only a rate limit, a server
 * error or no usable answer throws, which offers Try again. What it throws is
 * an `EmailLinkError` with the response's status (`0` when none arrived) and
 * the server's code, which `describeAuthError` reads.
 */
import { OsnApiError } from "./api-error";
import { reach, responseError } from "./auth-fetch";
import { safeJson } from "./response-body";

/** The flows whose links this client confirms, as the confirm page names them. */
export type EmailLinkPurpose = "sign-up" | "recovery" | "step-up" | "email-change";

/** Request-id prefixes, one per flow, as osn-api mints them. */
const PURPOSE_BY_PREFIX = {
  signup: "sign-up",
  recovery: "recovery",
  stepup: "step-up",
  emailchange: "email-change",
} as const satisfies Record<string, EmailLinkPurpose>;

type LinkPrefix = keyof typeof PURPOSE_BY_PREFIX;

const isLinkPrefix = (prefix: string): prefix is LinkPrefix =>
  Object.hasOwn(PURPOSE_BY_PREFIX, prefix);

const REQUEST_ID = /^([a-z]+)_[a-f0-9]{12}$/;

/** The flow an emailed link's request id belongs to, read off its prefix; null for anything else. */
export function emailLinkPurpose(requestId: string): EmailLinkPurpose | null {
  const prefix = REQUEST_ID.exec(requestId)?.[1];
  return prefix !== undefined && isLinkPrefix(prefix) ? PURPOSE_BY_PREFIX[prefix] : null;
}

export class EmailLinkError extends OsnApiError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = "EmailLinkError";
  }
}

export interface EmailLinkClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

/** What a confirm answered: the number accepted, the decline accepted, or a refusal. */
export type EmailLinkConfirmAnswer = "confirmed" | "declined" | "expired";

/** The pick that tells osn-api the reader did not ask for the request. */
const DECLINE_PICK = "none";

/** What the candidates read found. */
export type EmailLinkCandidates =
  | { readonly status: "ready"; readonly candidates: readonly string[] }
  | { readonly status: "confirmed" }
  | { readonly status: "expired" };

export interface EmailLinkClient {
  /**
   * The numbers the confirm page offers, one of them the number the tab that
   * began shows, sorted ascending as osn-api sends them. The right one is
   * equally likely to be at any place, so pass the list on as given.
   * `confirmed` when the request already is.
   */
  candidates(requestId: string, linkSecret: string): Promise<EmailLinkCandidates>;
  /**
   * Confirms with the reader's pick, sent exactly as given; `pick: null` says
   * they did not ask for the request. A number answers `confirmed` or
   * `expired` (a wrong pick ends the request); a decline answers `declined`,
   * again when repeated, or `expired`.
   */
  confirm(
    requestId: string,
    input: { linkSecret: string; pick: string | null },
  ): Promise<EmailLinkConfirmAnswer>;
}

/** The fields the two routes answer with; anything else in the body is ignored. */
interface LinkAnswer {
  readonly status?: unknown;
  readonly pairingCandidates?: unknown;
}

export function createEmailLinkClient(config: EmailLinkClientConfig): EmailLinkClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  /**
   * POSTs `body`; null for a refusal, the JSON body otherwise. Throws on a
   * rate limit, a server error, no answer, or a success whose body is not JSON.
   */
  async function post(path: string, body: unknown): Promise<LinkAnswer | null> {
    const res = await reach(EmailLinkError, `${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      throw responseError(EmailLinkError, res, await safeJson(res));
    }
    if (!res.ok) return null;
    const answer = await safeJson<LinkAnswer>(res);
    if (answer === null) throw responseError(EmailLinkError, res, answer);
    return answer;
  }

  return {
    async candidates(requestId, linkSecret) {
      const body = await post(`/email-link/${encodeURIComponent(requestId)}/candidates`, {
        linkSecret,
      });
      if (body?.status === "confirmed") return { status: "confirmed" };
      if (body?.status === "ready" && Array.isArray(body.pairingCandidates)) {
        return { status: "ready", candidates: body.pairingCandidates.map(String) };
      }
      return { status: "expired" };
    },
    async confirm(requestId, input) {
      const declining = input.pick === null;
      const body = await post(`/email-link/${encodeURIComponent(requestId)}/confirm`, {
        linkSecret: input.linkSecret,
        pairingPick: declining ? DECLINE_PICK : input.pick,
      });
      // Only the answer that fits what was sent: a number is never declined,
      // and a decline never confirmed.
      if (declining) return body?.status === "declined" ? "declined" : "expired";
      return body?.status === "confirmed" ? "confirmed" : "expired";
    },
  };
}
