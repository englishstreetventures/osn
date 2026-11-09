/**
 * Runs one copy of the installed provider's R2 multipart-upload module under
 * Bun's own loader, as a deploy's `bun alchemy` loads it, against a scripted
 * Cloudflare API and R2 with no network:
 * `bun tests/support/r2-multipart-abort.ts <provider directory> <copy>`.
 * Prints one JSON line: the module's result, each request it sent, and every
 * file Bun loaded. tests/state-cli.test.ts (SC8) runs it, in a process of its
 * own because Vitest resolves a package's TypeScript copy under conditions
 * Bun does not.
 */
import { join } from "node:path";

import { Credentials } from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Redacted from "effect/Redacted";

/** The part of the multipart-upload module this drives. */
interface MultipartModule {
  readonly abortMultipartUploads: (
    accountId: string,
    bucketName: string,
    jurisdiction: "default",
  ) => Effect.Effect<{ readonly aborted: number } | { readonly skipped: string }, never, unknown>;
}

/** R2's reply to listing the bucket's multipart uploads: one, not truncated. */
const LIST_UPLOADS = `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>cire-assets-dev</Bucket>
  <KeyMarker></KeyMarker>
  <UploadIdMarker></UploadIdMarker>
  <MaxUploads>1000</MaxUploads>
  <IsTruncated>false</IsTruncated>
  <Upload>
    <Key>weddings/w1/cover.jpg</Key>
    <UploadId>upload-1</UploadId>
    <Initiated>2026-11-01T00:00:00.000Z</Initiated>
  </Upload>
</ListMultipartUploadsResult>`;

const [providerDir = "", copy = ""] = process.argv.slice(2);
if (providerDir === "" || copy === "") {
  process.stderr.write("pass the provider's directory and the copy to run\n");
  process.exit(2);
}

const requests: string[] = [];
const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new globalThis.Request(input, init);
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}${url.search}`);
  if (url.pathname.endsWith("/tokens/verify")) {
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: { id: "token-id", status: "active" },
    });
  }
  if (request.method === "GET" && url.searchParams.has("uploads")) {
    return new Response(LIST_UPLOADS, { headers: { "content-type": "application/xml" } });
  }
  if (request.method === "DELETE" && url.searchParams.get("uploadId") === "upload-1") {
    return new Response(null, { status: 204 });
  }
  return new Response("unscripted", { status: 599 });
};

const module = (await import(join(providerDir, copy))) as MultipartModule;
const result = await Effect.runPromise(
  module.abortMultipartUploads("account", "cire-assets-dev", "default").pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
    Effect.provideService(
      Credentials,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("token"),
        apiBaseUrl: "https://api.cloudflare.test/client/v4",
      }),
    ),
    Effect.timeout("10 seconds"),
  ) as Effect.Effect<unknown, unknown, never>,
);
process.stdout.write(
  `${JSON.stringify({ result, requests, loaded: Object.keys(require.cache) })}\n`,
);
