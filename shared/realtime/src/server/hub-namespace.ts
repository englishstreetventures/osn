import type { Signal } from "../protocol";

/**
 * Subjects whose sockets the hub closes after it has sent the signal. Each
 * entry must be exactly the subject `authenticate` returned for that member,
 * since the hub tags sockets with it; any other string closes nothing. A
 * subject in both lists is revoked.
 */
export interface CloseTargets {
  /** Closed with 4001: the client reconnects and the member is checked again. */
  readonly evict?: readonly string[];
  /** Closed with 1008: the client stops, so a removed member makes no refused attempts. */
  readonly revoke?: readonly string[];
}

/**
 * The slice of a hub's Durable Object stub the helpers use. A product's
 * `DurableObjectNamespace<TopicHub>` satisfies `HubNamespace`, so production
 * passes its binding and tests pass a stand-in.
 */
export interface HubStub {
  fetch(request: Request): Promise<Response>;
  /** Resolves to how many sockets the signal reached. */
  publish(signal: Signal, targets: CloseTargets): Promise<number>;
}

export interface HubNamespace {
  getByName(name: string): HubStub;
}
