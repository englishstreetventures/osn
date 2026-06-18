/**
 * Email-transport selection for @osn/api — shared by the Bun entry
 * (`local.ts`) and the Cloudflare Workers entry (`index.ts`) so the
 * fail-closed-by-default posture and the degraded-mode opt-in behave
 * identically on both runtimes.
 *
 * Selection rules (in priority order):
 *
 *   1. Resend key present (`RESEND_API_KEY`) in a non-local env
 *                                           → ResendEmailLive (preferred real
 *      transport; works on workerd via Resend's HTTP API, no paid Workers plan).
 *      Wins over every lower tier — even if Cloudflare creds and/or the degraded
 *      opt-in are also set — so a correctly-provisioned deploy is never
 *      accidentally downgraded. With Resend configured, `OSN_EMAIL_OPTIONAL` is
 *      no longer needed: a future Resend outage then fails closed like any other
 *      transport misconfig (the no-op degraded path is opt-in only).
 *
 *   2. Cloudflare creds present (`CLOUDFLARE_ACCOUNT_ID` +
 *      `CLOUDFLARE_EMAIL_API_TOKEN`)        → CloudflareEmailLive (legacy real
 *      transport, retained as a fallback). Creds win over the degraded opt-in.
 *
 *   3. Local env (`OSN_ENV` unset or "local") → LogEmailLive recorder
 *      (in-memory ring; dev/test only).
 *
 *   4. Non-local, no real provider, `OSN_EMAIL_OPTIONAL` truthy → NoopEmailLive.
 *      EXPLICIT opt-in to boot with email gracefully degraded: transactional
 *      mail is discarded (not delivered) and a loud startup warning is emitted.
 *
 *   5. Non-local, no real provider, opt-in UNSET → THROW (the safe default).
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
  makeResendEmailLive,
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
  const resendApiKey = env.RESEND_API_KEY;
  const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID;
  const cfEmailToken = env.CLOUDFLARE_EMAIL_API_TOKEN;

  // 1. Preferred real transport — Resend wins over everything, unconditionally,
  //    in any non-local env. (Locally the recorder is preferred so dev/test
  //    never make a live API call even if a key happens to be present.)
  if (resendApiKey && isNonLocal(env)) {
    return makeResendEmailLive({
      apiKey: resendApiKey,
      fromAddress: env.OSN_EMAIL_FROM,
    });
  }

  // 2. Legacy real transport — Cloudflare creds win over the degraded opt-in.
  if (cfAccountId && cfEmailToken) {
    return makeCloudflareEmailLive({
      accountId: cfAccountId,
      apiToken: cfEmailToken,
      fromAddress: env.OSN_EMAIL_FROM,
    });
  }

  // 3. Local — recorder, no creds required.
  if (!isNonLocal(env)) {
    return makeLogEmailLive().layer;
  }

  // 4. Non-local + no real provider + EXPLICIT opt-in → degraded no-op.
  if (isEmailOptionalOptIn(env[EMAIL_OPTIONAL_VAR])) {
    // Loud, redacted startup warning through the redacting logger (NOT
    // console.*). Names the mail classes that will silently NOT be delivered so
    // an operator understands the security impact.
    Effect.runSync(
      Effect.logWarning(
        "EMAIL DEGRADED: no real email provider configured (RESEND_API_KEY and " +
          "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_EMAIL_API_TOKEN all absent) and " +
          `${EMAIL_OPTIONAL_VAR} is set — booting with a NO-OP email transport. ` +
          "Transactional mail will NOT be delivered: OTP step-up codes, email-change " +
          "OTPs, and security-notice emails (passkey added/removed, recovery codes, " +
          "cross-device login) are all DISCARDED. Passkey login is primary and " +
          "unaffected. Re-enable by setting RESEND_API_KEY (preferred) and unsetting " +
          `${EMAIL_OPTIONAL_VAR}.`,
      ).pipe(Effect.provide(observabilityLayer)),
    );
    return makeNoopEmailLive();
  }

  // 5. Non-local + no real provider + no opt-in → fail closed (default).
  throw new Error(
    "RESEND_API_KEY (preferred) or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN " +
      "must be set in non-local environments. To deploy WITHOUT email (degraded), set " +
      `${EMAIL_OPTIONAL_VAR}=true explicitly — transactional mail will then be discarded, ` +
      "not delivered.",
  );
}
