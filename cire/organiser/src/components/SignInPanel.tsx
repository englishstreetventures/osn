import { createLoginClient, createRecoveryClient } from "@osn/client";
import { AuthProvider } from "@osn/client/solid";
import { SignIn } from "@osn/ui/auth";
import { Toaster } from "solid-toast";

import { OSN_ISSUER_URL } from "../lib/osn";

const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });
const recoveryClient = createRecoveryClient({ issuerUrl: OSN_ISSUER_URL });

/**
 * Login page island. SignIn must render inside AuthProvider — it adopts
 * the session via useAuth().adoptSession on ceremony success.
 */
export default function SignInPanel() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL }}>
      <SignIn
        client={loginClient}
        recoveryClient={recoveryClient}
        onSuccess={() => {
          window.location.href = "/";
        }}
      />
      <Toaster position="bottom-right" />
    </AuthProvider>
  );
}
