import type { RunPasskeyRegistration } from "@osn/ui/auth/StepUpDialog";

/**
 * `runPasskeyRegistration`, fetched at the moment a ceremony actually runs.
 *
 * The Security tab reaches enrolment through a route that is already lazy, so
 * it imports `./webauthn-registration` directly. The **sign-in dialog** does
 * not: it is mounted by the desktop rail and the mobile top bar, so it is part
 * of the shell every anonymous visitor loads. Its recovery path can end in
 * passkey enrolment, and importing the ceremony statically to say so would put
 * `startRegistration` in that shell — paid by everyone, used by the handful of
 * people who lose a passkey.
 *
 * Hence the dynamic import. `vite.config.ts` gives `startRegistration.js` a
 * chunk of its own, so this defers a network fetch rather than merely a parse,
 * and `tests/webauthn-chunks.test.ts` pins that it stays dynamic.
 *
 * The deferral is safe for the ceremony itself: `startRegistration` is called
 * after an awaited `/passkey/register/begin`, so nothing here is running
 * inside a user-gesture window that an extra await could close.
 */
export const runPasskeyRegistrationDeferred: RunPasskeyRegistration = async (options) => {
  const { runPasskeyRegistration } = await import("./webauthn-registration");
  return runPasskeyRegistration(options);
};
