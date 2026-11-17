import {
  createAccountClient,
  createAppStepUpClient,
  createConnectionsClient,
  createEmailLinkClient,
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
// Unauthenticated and cookieless: confirming a link never signs this browser in.
export const emailLinkClient = createEmailLinkClient({ issuerUrl: OSN_ISSUER_URL });

// Authenticated: each sends through the page runtime, which supplies and
// renews the access token. No component handles a token.
const authenticated = { issuerUrl: OSN_ISSUER_URL, authFetch: osnAuth.authFetch };

export const recoveryClient = createRecoveryClient(authenticated);
export const passkeysClient = createPasskeysClient(authenticated);
export const stepUpClient = createStepUpClient(authenticated);
export const connectionsClient = createConnectionsClient(authenticated);
export const securityEventsClient = createSecurityEventsClient(authenticated);
export const totpClient = createTotpClient(authenticated);
// The data download, the emailed link to it, and the account's deletion and
// its undo. The download, the status and the undo answer a pending-deletion
// session too; the link, the deletion and its preview do not.
export const accountClient = createAccountClient(authenticated);
// An app's step-up request: the confirm page reads it and confirms it.
export const appStepUpClient = createAppStepUpClient(authenticated);
