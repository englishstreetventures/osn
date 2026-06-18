/**
 * Email-transport selection for @osn/api — shared by the Bun entry
 * (`local.ts`) and the Cloudflare Workers entry (`index.ts`) so the
 * fail-closed-by-default posture and the degraded-mode opt-in behave
 * identically on both runtimes.
 *
 * Selection rules (in priority order):
 *
 *   1. Cloudflare creds present (`CLOUDFLARE_ACCOUNT_ID` +
 *      `CLOUDFLARE_EMAIL_API_TOKEN`)        → CloudflareEmailLive.
 *      Creds always win — even if the degraded opt-in is also set — so a
 *      correctly-provisioned deploy is never accidentally downgraded.
 *
 *   2. Local env (`OSN_ENV` unset or "local") → LogEmailLive recorder
 *      (in-memory ring; dev/test only).
 *
 *   3. Non-local, creds absent, `OSN_EMAIL_OPTIONAL` truthy → NoopEmailLive.
 *      EXPLICIT opt-in to boot with email gracefully degraded: transactional
 *      mail is discarded (not delivered) and a loud startup warning is emitted.
 *
 *   4. Non-local, creds absent, opt-in UNSET → THROW (the safe default).
 *      A misconfigured deploy fails closed at startup rather than silently
 *      running without email.
 *
 * The opt-in is a non-secret boolean `[vars]` entry (`OSN_EMAIL_OPTIONAL`),
 * intentionally separate from the creds so degradation is never implicit.
 */

import {
  makeCloudflareEmailLive,
  makeLogEmailLive,
  makeNoopEmailLive,
  type EmailService,
} from "@shared/email";
import { Effect, Layer } from "effect";

/** Loose env view — both entries supply `process.env` / the Workers `env`. */
type EmailEnv = Readonly<Record<string, string | undefined>>;

const isNonLocal = (env: EmailEnv): boolean => !!env.OSN_ENV && env.OSN_ENV !== "local";

/**
 * The explicit degraded-email opt-in var name. Set truthy in a non-local env's
 * `[vars]` to allow osn-api to boot WITHOUT Cloudflare email — transactional
 * mail is then discarded, not delivered. Unset = fail-closed (the default).
 */
export const EMAIL_OPTIONAL_VAR = "OSN_EMAIL_OPTIONAL";

/** Truthy strings that enable the degraded-email opt-in. */
export const isEmailOptionalOptIn = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
};

/**
 * Pick the `EmailService` layer for this deployment from the env, emitting a
 * loud warning through `observabilityLayer` when (and only when) it selects the
 * degraded no-op transport. Throws when creds are absent in a non-local env and
 * the operator has NOT explicitly opted in (the fail-closed default).
 */
export function selectEmailLayer(
  env: EmailEnv,
  observabilityLayer: Layer.Layer<never>,
): Layer.Layer<EmailService> {
  const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID;
  const cfEmailToken = env.CLOUDFLARE_EMAIL_API_TOKEN;

  // 1. Real transport — creds win, unconditionally.
  if (cfAccountId && cfEmailToken) {
    return makeCloudflareEmailLive({
      accountId: cfAccountId,
      apiToken: cfEmailToken,
      fromAddress: env.OSN_EMAIL_FROM,
    });
  }

  // 2. Local — recorder, no creds required.
  if (!isNonLocal(env)) {
    return makeLogEmailLive().layer;
  }

  // 3. Non-local + creds absent + EXPLICIT opt-in → degraded no-op.
  if (isEmailOptionalOptIn(env[EMAIL_OPTIONAL_VAR])) {
    // Loud, redacted startup warning through the redacting logger (NOT
    // console.*). Names the mail classes that will silently NOT be delivered so
    // an operator understands the security impact.
    Effect.runSync(
      Effect.logWarning(
        "EMAIL DEGRADED: CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_EMAIL_API_TOKEN absent and " +
          `${EMAIL_OPTIONAL_VAR} is set — booting with a NO-OP email transport. ` +
          "Transactional mail will NOT be delivered: OTP step-up codes, email-change " +
          "OTPs, and security-notice emails (passkey added/removed, recovery codes, " +
          "cross-device login) are all DISCARDED. Passkey login is primary and " +
          "unaffected. Re-enable by setting the CLOUDFLARE_* creds and unsetting " +
          `${EMAIL_OPTIONAL_VAR}.`,
      ).pipe(Effect.provide(observabilityLayer)),
    );
    return makeNoopEmailLive();
  }

  // 4. Non-local + creds absent + no opt-in → fail closed (default).
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN must be set in non-local " +
      `environments. To deploy WITHOUT email (degraded), set ${EMAIL_OPTIONAL_VAR}=true ` +
      "explicitly — transactional mail will then be discarded, not delivered.",
  );
}
