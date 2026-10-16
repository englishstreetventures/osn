/**
 * A stand-in for the Resend API, so osn-api's real email path runs and the
 * flows can read the one-time codes it sends.
 *
 * osn-api sends through Resend when `RESEND_API_KEY` and a loopback
 * `RESEND_API_URL` are both set (`osn/api/src/local.ts`); it posts to `/emails`
 * and `/emails/batch` (`shared/email/src/resend.ts`). This server takes both,
 * keeps every message in arrival order, and serves them back at
 * `GET /__e2e/mail?to=<address>`.
 */

export interface CapturedMail {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
}

interface ResendPayload {
  readonly to?: string | readonly string[];
  readonly subject?: string;
  readonly text?: string;
}

function capture(payload: ResendPayload): CapturedMail {
  const to = typeof payload.to === "string" ? [payload.to] : [...(payload.to ?? [])];
  return { to, subject: payload.subject ?? "", text: payload.text ?? "" };
}

export interface MailServer {
  readonly port: number;
  readonly messages: readonly CapturedMail[];
  stop(): Promise<void>;
}

export function startMailServer(port: number): MailServer {
  const messages: CapturedMail[] = [];
  let sequence = 0;
  const nextId = (): string => `e2e-mail-${++sequence}`;

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/emails") {
        messages.push(capture((await request.json()) as ResendPayload));
        return Response.json({ id: nextId() });
      }
      if (request.method === "POST" && url.pathname === "/emails/batch") {
        const batch = (await request.json()) as ResendPayload[];
        const data = batch.map((payload) => {
          messages.push(capture(payload));
          return { id: nextId() };
        });
        return Response.json({ data });
      }
      if (request.method === "GET" && url.pathname === "/__e2e/mail") {
        const to = url.searchParams.get("to") ?? "";
        return Response.json(messages.filter((m) => m.to.includes(to)));
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    port: server.port ?? port,
    messages,
    stop: () => server.stop(true),
  };
}
