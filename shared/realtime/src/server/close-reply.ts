/** Close codes the runtime keeps for itself: `close()` with one of them throws. */
const RESERVED_CLOSE_CODES: ReadonlySet<number> = new Set([1004, 1005, 1006, 1015]);

/**
 * The code a hub answers a client's close with: the client's own code, unless
 * the runtime reserves it — a socket that died without a close frame arrives
 * as 1006, which cannot be sent back — and then 1000.
 */
export const replyCloseCode = (received: number): number =>
  RESERVED_CLOSE_CODES.has(received) ? 1000 : received;
