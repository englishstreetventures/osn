import { createLoginClient, createRecoveryClient, createRegistrationClient } from "@osn/client";
import { AuthProvider } from "@osn/client/solid";
import { Register, SignIn } from "@osn/ui/auth";
import { createSignal, Show } from "solid-js";
import { Toaster } from "solid-toast";

import { OSN_ISSUER_URL } from "../lib/osn";

const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });
const recoveryClient = createRecoveryClient({ issuerUrl: OSN_ISSUER_URL });
const registrationClient = createRegistrationClient({ issuerUrl: OSN_ISSUER_URL });

// Public Turnstile sitekey, baked in at build time. Undefined ⇒ key-optional
// (no widget rendered; osn-api also skips siteverify). See deploy runbook.
const TURNSTILE_SITEKEY = import.meta.env.PUBLIC_TURNSTILE_SITEKEY;

type Mode = "signin" | "register";

const toDashboard = () => {
  window.location.href = "/";
};

/**
 * Login page island. SignIn / Register must render inside AuthProvider —
 * they adopt the session via useAuth().adoptSession on ceremony success.
 * Organisers who don't yet have an OSN account switch to the registration
 * flow; a freshly-created account is signed in immediately, so both paths
 * land on the dashboard.
 */
export default function SignInPanel() {
  const [mode, setMode] = createSignal<Mode>("signin");

  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <Show
        when={mode() === "register"}
        fallback={
          <div class="flex flex-col gap-4">
            <SignIn
              client={loginClient}
              recoveryClient={recoveryClient}
              onSuccess={toDashboard}
              turnstileSiteKey={TURNSTILE_SITEKEY}
            />
            <p class="text-muted-foreground text-center text-sm">
              New to OSN?{" "}
              <button
                type="button"
                class="text-primary font-medium hover:underline"
                onClick={() => setMode("register")}
              >
                Create an account
              </button>
            </p>
          </div>
        }
      >
        <Register
          client={registrationClient}
          onCancel={() => setMode("signin")}
          onSuccess={toDashboard}
          turnstileSiteKey={TURNSTILE_SITEKEY}
        />
      </Show>
      <Toaster position="bottom-right" />
    </AuthProvider>
  );
}
