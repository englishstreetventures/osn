import { createLoginClient, createRegistrationClient } from "@osn/client";

import { OSN_ISSUER_URL } from "./auth";

// Single instance per app process, built at module load. Both the shared
// `<Register />` and `<SignIn />` components in `@osn/ui/auth` accept a
// client prop — the consuming app decides how to build them so the shared
// components don't need to know about env config. We share one instance
// across mounts to avoid reallocating closures on every render.
export const registrationClient = createRegistrationClient({ issuerUrl: OSN_ISSUER_URL });
export const loginClient = createLoginClient({ issuerUrl: OSN_ISSUER_URL });
