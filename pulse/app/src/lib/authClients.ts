import {
  createAccountExportClient,
  createLoginClient,
  createRecoveryClient,
  createRegistrationClient,
  createStepUpClient,
} from "@osn/client";

import { OSN_ISSUER_URL } from "./auth";

// Single instance per app process, built at module load. The shared
// `<Register />` and `<SignIn />` components in `@osn/ui/auth` take
// these as props; the consuming app owns env config.
export const registrationClient = createRegistrationClient({ issuerUrl: OSN_ISSUER_URL });
export const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });
export const recoveryClient = createRecoveryClient({ issuerUrl: OSN_ISSUER_URL });
// Used by the Privacy & data settings panel — same OSN-issued endpoints
// the @osn/social app calls; Pulse just surfaces the affordance from a
// second app surface so users don't have to bounce between apps.
export const stepUpClient = createStepUpClient({ issuerUrl: OSN_ISSUER_URL });
export const accountExportClient = createAccountExportClient({ issuerUrl: OSN_ISSUER_URL });
