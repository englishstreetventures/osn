import {
  createConnectionsClient,
  createLoginClient,
  createPasskeysClient,
  createRecoveryClient,
  createRegistrationClient,
  createSecurityEventsClient,
  createStepUpClient,
  createTotpClient,
} from "@osn/client";

import { OSN_ISSUER_URL, osnAuth } from "./auth";

// Unauthenticated, or holding their own token (registration's first passkey).
export const registrationClient = createRegistrationClient({ issuerUrl: OSN_ISSUER_URL });
export const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });

// Authenticated: each sends through the page runtime, which supplies and
// renews the access token. No component handles a token.
const authenticated = { issuerUrl: OSN_ISSUER_URL, authFetch: osnAuth.authFetch };

export const recoveryClient = createRecoveryClient(authenticated);
export const passkeysClient = createPasskeysClient(authenticated);
export const stepUpClient = createStepUpClient(authenticated);
export const connectionsClient = createConnectionsClient(authenticated);
export const securityEventsClient = createSecurityEventsClient(authenticated);
export const totpClient = createTotpClient(authenticated);
