import { DurableObject } from "cloudflare:workers";

import {
  CLOSE_CODES,
  parseTopic,
  PING,
  PONG,
  type RealtimeProduct,
  type Signal,
} from "../protocol";
import { replyCloseCode } from "./close-reply";
import { HUB_SUBJECT_HEADER, HUB_TOPIC_HEADER } from "./headers";
import { metricHubCapacityRefused } from "./metrics";

/** The runtime caps a socket tag at 256 characters; the tag is `subject:` plus this. */
const MAX_SUBJECT_LENGTH = 200;

const subjectTag = (subject: string): string => `subject:${subject}`;

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
 * "something changed" to every socket on its topic.
 */
export class TopicHub extends DurableObject<unknown> {
  /** Open sockets one topic may hold. A subclass may lower it; the tests do. */
  static socketCap = 50;
  /**
   * Open sockets one subject may hold on a topic. A member still over this
   * cap after stale sockets are closed does not get refused: the hub closes
   * that member's own least recently seen other socket with 1008 instead, so
   * a member's own dead sockets (a laptop or phone that changed network)
   * cannot lock out their live tab.
   */
  static subjectCap = 5;
  /**
   * A socket that has not pinged for this long (or, never having pinged, was
   * accepted this long ago) gives up its place at either cap, before a member's
   * own socket is closed or the topic refuses a newcomer. This assumes the
   * client's default 25 s `pingIntervalMs` (three intervals) and must grow if
   * that interval does. A hidden Chromium tab is throttled but still fires its
   * timers roughly once a minute; only a frozen or discarded tab stops
   * outright, and that socket reconnects once it is live again.
   */
  static staleAfterMs = 75_000;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * Accept an upgrade that `subscribe()` built. It carries the topic and the
   * admitted subject in headers only a product Worker can set. At either cap
   * it first closes sockets stale for `staleAfterMs`; if the subject is still
   * over its cap it closes that subject's own least recently seen other
   * socket (never the newcomer); if the topic is still over its cap it
   * refuses the newcomer instead.
   */
  override fetch(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 426 });
    }
    const parsed = parseTopic(request.headers.get(HUB_TOPIC_HEADER) ?? "");
    const subject = request.headers.get(HUB_SUBJECT_HEADER) ?? "";
    if (!parsed || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) {
      return new Response(null, { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [subjectTag(subject)]);
    server.serializeAttachment({ acceptedAt: Date.now() });
    if (this.overSubjectCap(subject) || this.overTopicCap()) {
      this.closeStale(server);
      if (this.overSubjectCap(subject))
        this.evictLeastRecentlySeen(subject, server, parsed.product);
      if (this.overTopicCap()) this.refuse(server, parsed.product);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Send `signal` to every socket on the topic, then close each evicted
   * subject's sockets so they reconnect and are checked again. A socket that
   * cannot be written to is closed. Returns how many sockets the signal reached.
   */
  publish(signal: Signal, evictSubjects: readonly string[] = []): number {
    const frame = JSON.stringify(signal);
    let reached = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
        reached += 1;
      } catch {
        closeQuietly(ws, 1011, "send failed");
      }
    }
    for (const subject of evictSubjects) {
      for (const ws of this.ctx.getWebSockets(subjectTag(subject))) {
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

  private overSubjectCap(subject: string): boolean {
    const hub = this.constructor as typeof TopicHub;
    return this.open(subjectTag(subject)).length > hub.subjectCap;
  }

  private overTopicCap(): boolean {
    const hub = this.constructor as typeof TopicHub;
    return this.open().length > hub.socketCap;
  }

  /** When the runtime last answered `ws`'s ping, or when it was accepted if it never pinged. */
  private lastSeen(ws: WebSocket): number {
    return this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? acceptedAt(ws);
  }

  /** Close every socket but `keep` that has not pinged within `staleAfterMs`. */
  private closeStale(keep: WebSocket): void {
    const staleBefore = Date.now() - (this.constructor as typeof TopicHub).staleAfterMs;
    for (const ws of this.open()) {
      if (ws === keep) continue;
      if (this.lastSeen(ws) < staleBefore) closeQuietly(ws, CLOSE_CODES.stale, "stale");
    }
  }

  /**
   * Close `subject`'s own least recently seen socket other than `keep`, so a
   * member over their cap loses a dead socket rather than the newcomer.
   */
  private evictLeastRecentlySeen(subject: string, keep: WebSocket, product: RealtimeProduct): void {
    const others = this.open(subjectTag(subject)).filter((ws) => ws !== keep);
    if (others.length === 0) return;
    const oldest = others.reduce((least, ws) =>
      this.lastSeen(ws) < this.lastSeen(least) ? ws : least,
    );
    metricHubCapacityRefused(product);
    closeQuietly(oldest, CLOSE_CODES.policy, "subject full");
  }

  private refuse(ws: WebSocket, product: RealtimeProduct): void {
    metricHubCapacityRefused(product);
    closeQuietly(ws, CLOSE_CODES.policy, "topic full");
  }
}
