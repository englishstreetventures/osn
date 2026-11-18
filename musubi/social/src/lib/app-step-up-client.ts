/**
 * An app's step-up request client, for `/confirm/:requestId` alone. Built
 * here rather than in `authClients.ts`, which most pages load, so it rides in
 * the confirm page's own chunk. It sends through the page runtime, as every
 * authenticated client does, so no component handles a token.
 */
import { createAppStepUpClient } from "@osn/client";

import { OSN_ISSUER_URL, osnAuth } from "./auth";

export const appStepUpClient = createAppStepUpClient({
  issuerUrl: OSN_ISSUER_URL,
  authFetch: osnAuth.authFetch,
});
