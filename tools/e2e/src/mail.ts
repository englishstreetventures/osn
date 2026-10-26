/**
 * A stand-in for the Resend API, so osn-api's real email path runs and the
 * flows can read the one-time codes it sends.
 *
 * osn-api sends through Resend when `RESEND_API_KEY` and a loopback
 * `RESEND_API_URL` are both set (`osn/api/src/local.ts`); it posts to `/emails`
 * and `/emails/batch` (`shared/email/src/resend.ts`). This server takes both,
 * keeps every message in arrival order, and serves them back at
 * `GET /__e2e/mail?to=<address>`.
 *
 * A flow can make the next send to one address fail: `POST /__e2e/mail/refuse`
 * with `{ "to": "<address>" }` arms it, and that send gets a 403 in Resend's
 * error shape, `validation_error` with an unverified-domain message, the way
 * Resend refuses a sender it has not verified. Unlike Resend's own message,
 * this one names the recipient, on purpose: it is what lets a flow check that
 * the transport's log never repeats the message. A refused message is not kept,
 * so a flow reading codes never reads one nobody received.
 * `GET /__e2e/mail/refused?to=<address>` answers how many sends to it were
 * refused.
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

/** The refusal a flow arms: Resend's 403 for a sender domain it has not verified. */
function refusal(to: string): Response {
  return Response.json(
    {
      statusCode: 403,
      name: "validation_error",
      message: `The e2e.test domain is not verified. Please, add and verify your domain. (to: ${to})`,
    },
    { status: 403 },
  );
}

export function startMailServer(port: number): MailServer {
  const messages: CapturedMail[] = [];
  const armed = new Set<string>();
  const refused = new Map<string, number>();
  let sequence = 0;
  const nextId = (): string => `e2e-mail-${++sequence}`;

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/emails") {
        const mail = capture((await request.json()) as ResendPayload);
        const target = mail.to.find((to) => armed.has(to));
        if (target !== undefined) {
          armed.delete(target);
          refused.set(target, (refused.get(target) ?? 0) + 1);
          return refusal(target);
        }
        messages.push(mail);
        return Response.json({ id: nextId() });
      }
      if (request.method === "POST" && url.pathname === "/__e2e/mail/refuse") {
        const { to } = (await request.json()) as { to?: string };
        if (!to) return new Response("to is required", { status: 400 });
        armed.add(to);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && url.pathname === "/__e2e/mail/refused") {
        return Response.json({ count: refused.get(url.searchParams.get("to") ?? "") ?? 0 });
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
