import { createPasskeysClient, createStepUpClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { PasskeysView } from "@osn/ui/auth";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { createMemo, Show } from "solid-js";

import { OSN_ISSUER_URL } from "../lib/osn";

// Built once against the OSN issuer. These wrap the same osn-api endpoints the
// rest of the portal authenticates against (id.cireweddings.com in prod).
const passkeysClient = createPasskeysClient({ issuerUrl: OSN_ISSUER_URL });
const stepUpClient = createStepUpClient({ issuerUrl: OSN_ISSUER_URL });

/**
 * Security → Devices panel for the organiser portal. Renders the shared
 * `@osn/ui` `PasskeysView` so a signed-in organiser can list, rename, and
 * remove their passkeys, and enrol a new device.
 *
 * passkeyOnly is forced on: cire's osn-api deployment runs with
 * `OSN_EMAIL_OPTIONAL=true` (Cloudflare email is degraded), so the OTP
 * step-up factor would silently never deliver. Every passkey-management
 * gate accepts a passkey step-up, so the ceremony stays fully functional
 * without email.
 *
 * The WebAuthn browser ceremonies are wired here with
 * `@simplewebauthn/browser` so `@osn/ui` stays free of that dependency.
 */
export default function SecurityPanel() {
  const { session, activeProfileId } = useAuth();

  // session() is a reactive Resource; reading it inside this memo keeps the
  // access token current as the SDK silently refreshes it.
  const accessToken = createMemo(() => session()?.accessToken ?? null);
  const webauthnSupported = createMemo(() => browserSupportsWebAuthn());

  const runPasskeyCeremony = (options: unknown) =>
    startAuthentication({
      optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
    });

  const runPasskeyRegistration = (options: unknown) =>
    startRegistration({
      optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"],
    });

  return (
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-1">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">Security</p>
        <h2 class="font-display text-[1.4rem] italic">Your devices &amp; passkeys</h2>
        <p class="font-body text-text-muted text-[0.88rem]">
          Passkeys are how you sign in to the organiser portal. Add one for each device you use, and
          remove any you no longer recognise.
        </p>
      </div>

      <Show
        when={webauthnSupported()}
        fallback={
          <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
            This browser doesn&apos;t support passkeys. Open the portal in a recent browser (iOS
            16+, Android 9+, or an up-to-date desktop browser) to manage your devices.
          </p>
        }
      >
        <Show
          when={accessToken()}
          fallback={
            <p class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase">
              Loading…
            </p>
          }
        >
          {(token) => (
            <PasskeysView
              client={passkeysClient}
              stepUpClient={stepUpClient}
              accessToken={token()}
              profileId={activeProfileId() ?? undefined}
              passkeyOnly
              runPasskeyCeremony={runPasskeyCeremony}
              runPasskeyRegistration={runPasskeyRegistration}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}
