import { createLoginClient, createRecoveryClient, createRegistrationClient } from "@osn/client";

import { OSN_ISSUER_URL } from "./auth";

export const registrationClient = createRegistrationClient({ issuerUrl: OSN_ISSUER_URL });
export const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });
export const recoveryClient = createRecoveryClient({ issuerUrl: OSN_ISSUER_URL });
