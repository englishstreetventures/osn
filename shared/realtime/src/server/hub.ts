import { DurableObject } from "cloudflare:workers";

import { CLOSE_CODES, parseTopic, PING, PING_INTERVAL_MS, PONG, type Signal } from "../protocol";
import { replyCloseCode } from "./close-reply";
import {
  HUB_CAPACITY_HEADER,
  HUB_SUBJECT_HEADER,
  HUB_TOPIC_HEADER,
  type HubCapacity,
} from "./headers";
import type { CloseTargets } from "./hub-namespace";

/**
 * An opaque member id: the runtime caps a socket tag at 256 characters, and
 * the tag is `subject:` plus this. A handle, email or display name does not
 * match, so a product that passes one fails at once rather than tagging
 * sockets with personal data that two members may share.
 */
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const SUBJECT_TAG_PREFIX = "subject:";
const subjectTag = (subject: string): string => `${SUBJECT_TAG_PREFIX}${subject}`;

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed or closing: there is nothing left to do.
  }
}

/** When the socket was accepted, kept on the socket so it survives hibernation. */
function acceptedAt(ws: WebSocket): number {
  const attachment: unknown = ws.deserializeAttachment();
  return typeof attachment === "object" &&
    attachment !== null &&
    "acceptedAt" in attachment &&
    typeof attachment.acceptedAt === "number"
    ? attachment.acceptedAt
    : 0;
}

/**
 * One topic's open sockets, one instance per topic (`getByName(topic)`).
 *
 * It holds sockets through the hibernation API and nothing else — no storage,
 * no alarm, no timer — so between signals it sleeps and is not billed for
 * duration. The client's `ping` is answered by the runtime's auto-response
 * without waking it. Signals carry no data: a woken hub only forwards
 * "something changed" to every socket on its topic. Caps and close codes are
 * described in `wiki/shared/realtime.md`.
 */
export class TopicHub extends DurableObject<unknown> {
  /** Open sockets one topic may hold. A subclass may lower it; the tests do. */
  static socketCap = 50;
  /**
   * Open sockets one subject may hold on a topic. Over it, the hub closes that
   * member's least recently seen other socket with 1008 and keeps the newcomer.
   */
  static subjectCap = 5;
  /**
   * A socket that has not pinged for this long (or, never having pinged, was
   * accepted this long ago) gives up its place at either cap. Three ping
   * intervals, so a live tab never counts as stale.
   */
  static staleAfterMs = 3 * PING_INTERVAL_MS;
  /**
   * A socket accepted longer ago than this is closed with 4001 at the next
   * publish instead of being sent the signal, so it reconnects and its session
   * and membership are checked again before it hears anything more.
   */
  static maxSocketAgeMs = 60 * 60_000;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private get limits(): typeof TopicHub {
    return this.constructor as typeof TopicHub;
  }

  /**
   * Accept an upgrade that `subscribe()` built. It carries the topic and the
   * admitted subject in headers only a product Worker can set. At either cap
   * it first closes sockets stale for `staleAfterMs`; if the subject is still
   * over its cap it closes that subject's own least recently seen other
   * socket (never the newcomer); if the topic is still over its cap it closes
   * the newcomer instead. The 101 names the cap that was hit, if any.
   */
  override fetch(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 426 });
    }
    const parsed = parseTopic(request.headers.get(HUB_TOPIC_HEADER) ?? "");
    const subject = request.headers.get(HUB_SUBJECT_HEADER) ?? "";
    if (!parsed || !SUBJECT_PATTERN.test(subject)) {
      return new Response(null, { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const tag = subjectTag(subject);
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ acceptedAt: Date.now() });

    let capacity: HubCapacity | undefined;
    let subjectSockets = this.open(tag);
    let topicSockets = this.open().length;
    if (subjectSockets.length > this.limits.subjectCap || topicSockets > this.limits.socketCap) {
      topicSockets = this.closeStale(server);
      subjectSockets = this.open(tag);
      if (
        subjectSockets.length > this.limits.subjectCap &&
        this.closeLeastRecentlySeen(subjectSockets, server)
      ) {
        topicSockets -= 1;
        capacity = "subject";
      }
      if (topicSockets > this.limits.socketCap) {
        closeQuietly(server, CLOSE_CODES.policy, "topic full");
        capacity = "topic";
      }
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: capacity ? { [HUB_CAPACITY_HEADER]: capacity } : undefined,
    });
  }

  /**
   * Send `signal` to every open socket on the topic and close the named
   * subjects' sockets after it (see {@link CloseTargets}). A socket older than
   * `maxSocketAgeMs` is not sent the signal and is closed with 4001. A revoked
   * subject's socket is closed with 1008 whatever else applies, so its client
   * stops rather than reconnecting. Returns how many sockets the signal reached.
   */
  publish(signal: Signal, targets: CloseTargets = {}): number {
    const frame = JSON.stringify(signal);
    const expiredBefore = Date.now() - this.limits.maxSocketAgeMs;
    const evict = new Set(targets.evict);
    const revoke = new Set(targets.revoke);
    let reached = 0;
    for (const ws of this.open()) {
      const subject = this.subjectOf(ws);
      const revoked = subject !== undefined && revoke.has(subject);
      const expired = acceptedAt(ws) < expiredBefore;
      if (!expired) {
        try {
          ws.send(frame);
          reached += 1;
        } catch {
          closeQuietly(ws, revoked ? CLOSE_CODES.policy : 1011, "send failed");
          continue;
        }
      }
      if (revoked) closeQuietly(ws, CLOSE_CODES.policy, "access revoked");
      else if (expired) closeQuietly(ws, CLOSE_CODES.evicted, "expired");
      else if (subject !== undefined && evict.has(subject)) {
        closeQuietly(ws, CLOSE_CODES.evicted, "membership changed");
      }
    }
    return reached;
  }

  /**
   * `ping` is the only frame a client may send, and the runtime answers it
   * without calling this. Anything else is closed, so a client cannot keep the
   * hub awake by talking to it.
   */
  override webSocketMessage(ws: WebSocket): void {
    closeQuietly(ws, CLOSE_CODES.policy, "unexpected frame");
  }

  /** Answer the client's close; see {@link replyCloseCode}. */
  override webSocketClose(ws: WebSocket, code: number): void {
    closeQuietly(ws, replyCloseCode(code), "closing");
  }

  override webSocketError(ws: WebSocket): void {
    closeQuietly(ws, 1011, "socket error");
  }

  private open(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** The subject `fetch` tagged `ws` with. */
  private subjectOf(ws: WebSocket): string | undefined {
    const tag = this.ctx.getTags(ws).find((t) => t.startsWith(SUBJECT_TAG_PREFIX));
    return tag?.slice(SUBJECT_TAG_PREFIX.length);
  }

  /** When the runtime last answered `ws`'s ping, or when it was accepted if it never pinged. */
  private lastSeen(ws: WebSocket): number {
    return this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? acceptedAt(ws);
  }

  /**
   * Close every socket but `keep` that has not pinged within `staleAfterMs`.
   * Returns how many open sockets the topic holds afterwards, `keep` included.
   */
  private closeStale(keep: WebSocket): number {
    const staleBefore = Date.now() - this.limits.staleAfterMs;
    let left = 0;
    for (const ws of this.open()) {
      if (ws !== keep && this.lastSeen(ws) < staleBefore) {
        closeQuietly(ws, CLOSE_CODES.stale, "stale");
      } else {
        left += 1;
      }
    }
    return left;
  }

  /**
   * Close the least recently seen socket in `subjectSockets` other than
   * `keep`, so a member over their cap loses an idle socket rather than the
   * newcomer. Returns whether it closed one.
   */
  private closeLeastRecentlySeen(subjectSockets: readonly WebSocket[], keep: WebSocket): boolean {
    let oldest: WebSocket | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const ws of subjectSockets) {
      if (ws === keep) continue;
      const seen = this.lastSeen(ws);
      if (seen < oldestSeen) {
        oldest = ws;
        oldestSeen = seen;
      }
    }
    if (!oldest) return false;
    closeQuietly(oldest, CLOSE_CODES.policy, "subject full");
    return true;
  }
}
