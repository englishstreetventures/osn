import { createCoordinationClient, type CoordinationNamespace } from "../../../src/client";
import { CoordinationStore } from "../../../src/store";

/** What a test can see of an object's storage: every stored key and the pending alarm. */
export interface StoreDump {
  readonly keys: readonly string[];
  readonly alarm: number | null;
}

/** The store with three test-only levers, so a test can see and steer its storage. */
export class ObservedStore extends CoordinationStore {
  async dump(): Promise<StoreDump> {
    const keys = [...this.ctx.storage.kv.list()].map(([key]) => key);
    return { keys, alarm: await this.ctx.storage.getAlarm() };
  }

  /** Runs the alarm handler now, as a late delivery of an older alarm would. */
  async fireAlarm(): Promise<void> {
    await this.alarm();
  }

  /** Drops the pending alarm, so expiry is left to the read-time check alone. */
  async cancelAlarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
}

interface Env {
  STORE: DurableObjectNamespace<ObservedStore>;
}

/** `NaN` does not survive JSON, so the test sends this string in its place. */
const NAN = "__NaN__";

/**
 * A call the test drives: `name` addresses the object directly; `namespace`
 * and `key` go through the client, so its object naming runs against a real
 * binding.
 */
interface CallRequest {
  readonly op: string;
  readonly args: readonly unknown[];
  readonly name?: string;
  readonly namespace?: string;
  readonly key?: string;
}

function decode(args: readonly unknown[]): unknown[] {
  return args.map((arg) => (arg === NAN ? Number.NaN : arg));
}

async function callObject(
  stub: DurableObjectStub<ObservedStore>,
  op: string,
  args: readonly unknown[],
): Promise<unknown> {
  switch (op) {
    case "increment":
      return stub.increment(args[0] as number);
    case "count":
      return stub.count();
    case "read":
      return stub.read();
    case "write":
      return stub.write(args[0] as string, args[1] as number);
    case "remove":
      return stub.remove();
    case "claim":
      return stub.claim(args[0] as number);
    case "guess":
      return stub.guess();
    case "take":
      return stub.take();
    case "dump":
      return stub.dump();
    case "fireAlarm":
      return stub.fireAlarm();
    case "cancelAlarm":
      return stub.cancelAlarm();
    default:
      throw new Error(`unknown op ${op}`);
  }
}

async function callClient(
  ns: CoordinationNamespace,
  namespace: string,
  key: string,
  op: string,
  args: readonly unknown[],
): Promise<unknown> {
  const client = createCoordinationClient(ns, { namespace });
  switch (op) {
    case "write":
      return client.write(key, args[0] as string, args[1] as number);
    case "read":
      return client.read(key);
    case "increment":
      return client.increment(key, args[0] as number);
    default:
      throw new Error(`unknown client op ${op}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const body = (await request.json()) as CallRequest;
    const args = decode(body.args);
    try {
      const result =
        body.name !== undefined
          ? await callObject(env.STORE.getByName(body.name), body.op, args)
          : await callClient(env.STORE, body.namespace ?? "", body.key ?? "", body.op, args);
      return Response.json({ ok: true, result: result ?? null });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return Response.json({ ok: false, name: failure.name, message: failure.message });
    }
  },
};
