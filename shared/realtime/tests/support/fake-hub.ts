import type { Signal } from "../../src/protocol";
import type { HubNamespace } from "../../src/server/hub-namespace";

export interface PublishCall {
  readonly name: string;
  readonly signal: Signal;
  readonly evictSubjects: readonly string[];
}

export interface FetchCall {
  readonly name: string;
  readonly request: Request;
}

/**
 * A hub binding the server tests drive by hand. Each call is recorded; the
 * two handlers decide what the "hub" answers.
 */
export function fakeHub(handlers: {
  publish?: (call: PublishCall) => Promise<number>;
  fetch?: (call: FetchCall) => Promise<Response>;
}): { hub: HubNamespace; publishes: PublishCall[]; fetches: FetchCall[] } {
  const publishes: PublishCall[] = [];
  const fetches: FetchCall[] = [];
  const hub: HubNamespace = {
    getByName: (name) => ({
      publish: (signal, evictSubjects) => {
        const call = { name, signal, evictSubjects };
        publishes.push(call);
        return handlers.publish ? handlers.publish(call) : Promise.resolve(0);
      },
      fetch: (request) => {
        const call = { name, request };
        fetches.push(call);
        return handlers.fetch
          ? handlers.fetch(call)
          : Promise.resolve(new Response(null, { status: 101 }));
      },
    }),
  };
  return { hub, publishes, fetches };
}
