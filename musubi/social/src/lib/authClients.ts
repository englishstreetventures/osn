import {
  createConnectionsClient,
  createLoginClient,
  createPasskeysClient,
  createRecoveryClient,
  createRegistrationClient,
  createSecurityEventsClient,
  createStepUpClient,
} from "@osn/client";

import { OSN_ISSUER_URL } from "./auth";

export const registrationClient = createRegistrationClient({ issuerUrl: OSN_ISSUER_URL });
export const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });
export const recoveryClient = createRecoveryClient({ issuerUrl: OSN_ISSUER_URL });
export const passkeysClient = createPasskeysClient({ issuerUrl: OSN_ISSUER_URL });
export const stepUpClient = createStepUpClient({ issuerUrl: OSN_ISSUER_URL });
export const connectionsClient = createConnectionsClient({ issuerUrl: OSN_ISSUER_URL });
export const securityEventsClient = createSecurityEventsClient({ issuerUrl: OSN_ISSUER_URL });
