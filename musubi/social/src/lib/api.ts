import { createGraphClient, createOrgClient, createRecommendationClient } from "@osn/client";

import { OSN_ISSUER_URL, osnAuth } from "./auth";

// Each sends through the page runtime, which supplies and renews the access token.
const authenticated = { issuerUrl: OSN_ISSUER_URL, authFetch: osnAuth.authFetch };

export const graphClient = createGraphClient(authenticated);
export const orgClient = createOrgClient(authenticated);
export const recommendationClient = createRecommendationClient(authenticated);
