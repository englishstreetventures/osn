/**
 * The Resend transport this Worker may use, from its env, or why it may not.
 *
 * `RESEND_API_KEY` turns real mail on. `RESEND_API_URL` points it at a local
 * Resend emulator instead of Resend itself: it must be a loopback origin, and a
 * deployed tier refuses it outright, so a deployed cire-api only ever sends to
 * Resend. A refused override leaves no transport rather than failing the
 * Worker — cire's email is fail-soft — and the caller logs `problem`, which
 * never repeats the value.
 */

import { resendApiUrlProblem, type ResendEmailConfig } from "@shared/email";

/** Every cire email goes out from the sender verified in Resend. */
const CIRE_EMAIL_FROM = "hello@cireweddings.com";

export interface ResendEmailSetup {
  /** The transport config, or null when mail must not go through Resend. */
  readonly config: ResendEmailConfig | null;
  /** Why the override was refused, for the caller to log; null when it was not. */
  readonly problem: string | null;
}

export function resendEmailConfig(
  env: { readonly RESEND_API_KEY?: string; readonly RESEND_API_URL?: string },
  deployed: boolean,
): ResendEmailSetup {
  const apiUrl = env.RESEND_API_URL?.trim() || undefined;
  if (apiUrl !== undefined) {
    if (deployed) {
      return {
        config: null,
        problem:
          "RESEND_API_URL is for local emulation only and must not be set in a deployed tier",
      };
    }
    const problem = resendApiUrlProblem(apiUrl);
    if (problem !== null) return { config: null, problem: `RESEND_API_URL ${problem}` };
  }
  if (!env.RESEND_API_KEY) return { config: null, problem: null };
  return {
    config: {
      apiKey: env.RESEND_API_KEY,
      fromAddress: CIRE_EMAIL_FROM,
      ...(apiUrl !== undefined && { apiUrl }),
    },
    problem: null,
  };
}

/**
 * The Resend config for the Bun dev server, or null to keep `createApp`'s
 * in-memory recorder. Mail leaves the dev server only for a local emulator —
 * `RESEND_API_KEY` and `RESEND_API_URL` both set — so a real key in the
 * environment never sends real mail from it. Throws on a refused override, so a
 * mistyped value stops the server rather than being ignored.
 */
export function localResendConfig(env: {
  readonly RESEND_API_KEY?: string;
  readonly RESEND_API_URL?: string;
}): ResendEmailConfig | null {
  const { config, problem } = resendEmailConfig(env, false);
  if (problem !== null) throw new Error(problem);
  return config?.apiUrl ? config : null;
}
