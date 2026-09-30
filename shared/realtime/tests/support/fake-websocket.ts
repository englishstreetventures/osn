/**
 * A WebSocket stand-in the client tests drive by hand. Every instance is
 * recorded, so a test can open it, deliver a frame or close it from the
 * "server" side, and see what the client sent.
 */
export class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  static throwOnConstruct = false;

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnConstruct = false;
  }

  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    super();
    if (FakeWebSocket.throwOnConstruct) throw new DOMException("blocked", "SecurityError");
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  /** Server side: the handshake completed. */
  serverOpen(): void {
    this.dispatchEvent(new Event("open"));
  }

  /** Server side: a text frame arrives. */
  serverSend(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** Server side or network: the socket closed with `code`. */
  serverClose(code = 1006): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

/** The constructor type the client's `WebSocket` option takes. */
export const FakeSocketClass = FakeWebSocket as unknown as new (url: string) => WebSocket;

export const latest = (): FakeWebSocket => {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no socket was opened");
  return socket;
};
