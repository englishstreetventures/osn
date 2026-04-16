import { createGraphClient, createOrgClient, createRecommendationClient } from "@osn/client";

import { OSN_ISSUER_URL } from "./auth";

export const graphClient = createGraphClient({ issuerUrl: OSN_ISSUER_URL });
export const orgClient = createOrgClient({ issuerUrl: OSN_ISSUER_URL });
export const recommendationClient = createRecommendationClient({ issuerUrl: OSN_ISSUER_URL });
