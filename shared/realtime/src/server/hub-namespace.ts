import type { Signal } from "../protocol";

/**
 * The slice of a hub's Durable Object stub the helpers use. A product's
 * `DurableObjectNamespace<TopicHub>` satisfies `HubNamespace`, so production
 * passes its binding and tests pass a stand-in.
 */
export interface HubStub {
  fetch(request: Request): Promise<Response>;
  /** Resolves to how many sockets the signal reached. */
  publish(signal: Signal, evictSubjects: readonly string[]): Promise<number>;
}

export interface HubNamespace {
  getByName(name: string): HubStub;
}
