import { Effect } from "effect";

import type { Signal } from "../../../src/protocol";
import { HUB_SUBJECT_HEADER, HUB_TOPIC_HEADER } from "../../../src/server/headers";
import { TopicHub } from "../../../src/server/hub";
import type { HubNamespace } from "../../../src/server/hub-namespace";
import { publish } from "../../../src/server/publish";
import { subscribe } from "../../../src/server/subscribe";

/** A hub that counts the frames that woke it, so a test can prove a ping did not. */
export class ObservedHub extends TopicHub {
  private woken = 0;

  override webSocketMessage(ws: WebSocket): void {
    this.woken += 1;
    super.webSocketMessage(ws);
  }

  wakes(): number {
    return this.woken;
  }

  sockets(): number {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length;
  }

  /** Close `subject`'s sockets and publish in the same turn, before any close reply. */
  closeThenPublish(subject: string, signal: Signal, evict: readonly string[]): number {
    for (const ws of this.ctx.getWebSockets(`subject:${subject}`)) ws.close(1000, "test");
    return this.publish(signal, { evict });
  }
}

/** Two sockets per topic, so the cap is reachable in a test. */
export class SmallHub extends ObservedHub {
  static override socketCap = 2;
}

/** Two sockets per topic, and a socket goes stale after 1 s without a ping. */
export class StaleHub extends ObservedHub {
  static override socketCap = 2;
  static override staleAfterMs = 1_000;
}

/** Two sockets per subject. */
export class SubjectHub extends ObservedHub {
  static override subjectCap = 2;
}

/** A socket older than 300 ms is closed on the next publish. */
export class AgedHub extends ObservedHub {
  static override maxSocketAgeMs = 300;
}

interface Env {
  HUB: DurableObjectNamespace<ObservedHub>;
  SMALL_HUB: DurableObjectNamespace<SmallHub>;
  STALE_HUB: DurableObjectNamespace<StaleHub>;
  SUBJECT_HUB: DurableObjectNamespace<SubjectHub>;
  AGED_HUB: DurableObjectNamespace<AgedHub>;
}

// Not exported: workerd treats every export of a Worker's main module as an
// entrypoint and refuses to start on one that is not a handler or a class.
const ORIGIN = "https://host.example.test";

function pick(env: Env, name: string | null): DurableObjectNamespace<ObservedHub> {
  if (name === "small") return env.SMALL_HUB;
  if (name === "stale") return env.STALE_HUB;
  if (name === "subject") return env.SUBJECT_HUB;
  if (name === "aged") return env.AGED_HUB;
  return env.HUB;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, action = "", rawTopic = ""] = url.pathname.split("/");
    const namespace = pick(env, url.searchParams.get("hub"));
    // The type-level proof that a real binding satisfies the helpers' shape.
    const hub: HubNamespace = namespace;
    const topic = decodeURIComponent(rawTopic);
    const evict = url.searchParams.getAll("evict");
    const revoke = url.searchParams.getAll("revoke");
    const signal: Signal = { topic, kind: "members-changed", at: Date.now() };

    if (action === "subscribe") {
      return Effect.runPromise(
        subscribe(request, rawTopic, {
          product: "cire",
          hub,
          allowedOrigins: [ORIGIN],
          acceptsTopic: () => true,
          authenticate: async (req) => req.headers.get("x-test-subject"),
          allow: async () => true,
          allowDaily: async () => true,
          authorize: async () => true,
        }),
      );
    }
    if (action === "publish") {
      // Straight to the hub's RPC method, so a test sees how many it reached.
      const reached = await namespace.getByName(topic).publish(signal, { evict, revoke });
      return Response.json({ reached });
    }
    if (action === "helper-publish") {
      await Effect.runPromise(
        publish(hub, topic, "members-changed", { evictSubjects: evict, revokeSubjects: revoke }),
      );
      return new Response(null, { status: 204 });
    }
    if (action === "close-then-publish") {
      const subject = url.searchParams.get("closed") ?? "";
      const reached = await namespace.getByName(topic).closeThenPublish(subject, signal, evict);
      return Response.json({ reached });
    }
    if (action === "raw") {
      // A request no product would send: the hub headers only when the test
      // names a subject, and the upgrade header unless `upgrade=0`.
      const headers = new Headers();
      if (url.searchParams.get("upgrade") !== "0") headers.set("upgrade", "websocket");
      const subject = url.searchParams.get("subject");
      if (subject !== null) {
        headers.set(HUB_TOPIC_HEADER, topic);
        headers.set(HUB_SUBJECT_HEADER, subject);
      }
      return namespace.getByName(topic).fetch(new Request(url, { headers }));
    }
    if (action === "stats") {
      const stub = namespace.getByName(topic);
      return Response.json({ sockets: await stub.sockets(), wakes: await stub.wakes() });
    }
    return new Response(null, { status: 404 });
  },
};
