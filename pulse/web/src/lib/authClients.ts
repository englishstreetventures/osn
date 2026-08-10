import { createLoginClient, createRecoveryClient, createRegistrationClient } from "@osn/client";

import { OSN_ISSUER_URL } from "./auth";

// Single instance per app process, built at module load. The shared
// `<Register />` and `<SignIn />` components in `@osn/ui/auth` take
// these as props; the consuming app owns env config.
export const registrationClient = createRegistrationClient({ issuerUrl: OSN_ISSUER_URL });
export const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });
export const recoveryClient = createRecoveryClient({ issuerUrl: OSN_ISSUER_URL });
