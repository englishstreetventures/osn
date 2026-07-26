import { parseTokenResponse, type Session } from "./tokens";

/**
 * Plain-fetch helpers for Copenhagen Book M2 — recovery codes.
 *
 *  1. `generateRecoveryCodes({ accessToken, stepUpToken })` — authenticated
 *     and step-up gated. Returns the fresh set once; replaces any existing
 *     set on the server.
 *  2. `getRecoveryCodesStatus({ accessToken })` — authenticated. Counts only,
 *     so a settings panel can say "you have none" without a ceremony.
 *  3. `loginWithRecoveryCode({ identifier, code })` — unauthenticated. Burns
 *     the supplied code and establishes a full session + profile. All other
 *     existing sessions for the account are revoked server-side.
 *
 * Kept in its own module so UI surfaces (settings panel, sign-in recovery
 * modal) can import the exact shape they need without pulling in the full
 * Effect-based `OsnAuth` service.
 */

export interface RecoveryClientConfig {
  /** OSN issuer base URL, e.g. http://localhost:4000 */
  issuerUrl: string;
}

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

/** Matches `PublicProfile` in `@osn/api`. */
export interface RecoveryProfile {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface RecoveryLoginResult {
  session: Session;
  profile: RecoveryProfile;
}

export interface RecoveryCodesStatus {
  /** Codes in the current set that have not been used yet. */
  active: number;
  /** Codes in the current set, used or not. 0 when none were ever generated. */
  total: number;
  /** Unix seconds the current set was minted, or null if there is no set. */
  generatedAt: number | null;
}

export interface RecoveryClient {
  /**
   * Generate a fresh batch of recovery codes. Returns the raw codes exactly
   * once — the caller must display + prompt the user to save them. Replaces
   * any previously generated set.
   *
   * Step-up gated (M-PK1): without a fresh `stepUpToken` the server answers
   * 403 `step_up_required`, so run the step-up ceremony first and pass the
   * token it mints.
   */
  generateRecoveryCodes(input: {
    accessToken: string;
    stepUpToken?: string;
  }): Promise<{ codes: string[] }>;
  /**
   * How many codes the account has left and when the set was minted. Carries
   * no secret, so it needs no step-up.
   */
  getRecoveryCodesStatus(input: { accessToken: string }): Promise<RecoveryCodesStatus>;
  /**
   * Exchange an identifier + recovery code for a session. Consumes the code
   * (single-use) and revokes all other sessions for the account.
   */
  loginWithRecoveryCode(input: { identifier: string; code: string }): Promise<RecoveryLoginResult>;
}

export function createRecoveryClient(config: RecoveryClientConfig): RecoveryClient {
  const base = config.issuerUrl.replace(/\/$/, "");

  const generateRecoveryCodes = async (input: { accessToken: string; stepUpToken?: string }) => {
    const res = await fetch(`${base}/recovery/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(input.stepUpToken ? { step_up_token: input.stepUpToken } : {}),
    });
    const json = (await res.json()) as { recoveryCodes?: string[]; error?: string };
    if (!res.ok || !Array.isArray(json.recoveryCodes)) {
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
    return { codes: json.recoveryCodes };
  };

  const getRecoveryCodesStatus = async (input: { accessToken: string }) => {
    const res = await fetch(`${base}/recovery/status`, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      credentials: "include",
    });
    const json = (await res.json()) as Partial<RecoveryCodesStatus> & { error?: string };
    if (!res.ok || typeof json.active !== "number" || typeof json.total !== "number") {
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
    return {
      active: json.active,
      total: json.total,
      generatedAt: typeof json.generatedAt === "number" ? json.generatedAt : null,
    };
  };

  const loginWithRecoveryCode = async (input: { identifier: string; code: string }) => {
    const res = await fetch(`${base}/login/recovery/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as {
      session?: unknown;
      profile?: RecoveryProfile;
      error?: string;
    };
    if (!res.ok || !json.session || !json.profile) {
      throw new RecoveryError(json.error ?? `Request failed: ${res.status}`);
    }
    return {
      session: parseTokenResponse(json.session),
      profile: json.profile,
    };
  };

  return { generateRecoveryCodes, getRecoveryCodesStatus, loginWithRecoveryCode };
}
