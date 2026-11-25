import { timingSafeEqualString } from "@shared/crypto/timing-safe";

/**
 * The gate of a route that answers only a caller holding a shared secret as
 * its bearer: 501 with `disabledMessage` when this instance holds no secret,
 * or one shorter than `minLength`; 401 unless `authorization` is exactly
 * `Bearer <secret>`, compared in constant time. Returns the refusal to send,
 * or null when the caller may go on. Nothing else about the request is read
 * first, so a caller without the secret learns nothing.
 */
export function refuseWithoutBearerSecret(
  secret: string | undefined,
  authorization: string | undefined,
  set: { status?: number | string },
  disabledMessage: string,
  minLength = 1,
): { error: string } | null {
  if (!secret || secret.length < minLength) {
    set.status = 501;
    return { error: disabledMessage };
  }
  if (!timingSafeEqualString(authorization ?? "", `Bearer ${secret}`)) {
    set.status = 401;
    return { error: "Unauthorized" };
  }
  return null;
}
