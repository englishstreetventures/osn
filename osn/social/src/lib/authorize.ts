import { createAuthorizeClient } from "@osn/client";

import { OSN_ISSUER_URL } from "./auth";

export const authorizeClient = createAuthorizeClient({ issuerUrl: OSN_ISSUER_URL });
