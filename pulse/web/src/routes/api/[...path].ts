import type { APIEvent } from "@solidjs/start/server";

import { proxyToPulseApi } from "../../lib/api-proxy";
import { internalApiUrl } from "../../lib/transport";

/**
 * pulse-api under `/api` on the web origin. Every method pulse-api serves to a
 * browser; same-origin calls send no preflight, so there is no OPTIONS.
 */
const forward = ({ request }: APIEvent): Promise<Response> =>
  proxyToPulseApi(request, internalApiUrl());

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
