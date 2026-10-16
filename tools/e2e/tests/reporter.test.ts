import { describe, expect, test } from "bun:test";

import { RECORD_ATTACHMENT, recordFor } from "../src/reporter";

describe("recordFor", () => {
  test("a flow that died before attaching its record still appears, with its real status", () => {
    expect(recordFor({ title: "cire-rsvp" }, { status: "timedOut", attachments: [] })).toEqual({
      flow: "cire-rsvp",
      status: "timedOut",
      steps: [],
      requests: [],
      assertions: [],
    });
  });

  test("the runner's status wins over whatever the record says", () => {
    const body = Buffer.from(
      JSON.stringify({ flow: "x", status: "passed", steps: ["a"], requests: [], assertions: [] }),
    );
    const record = recordFor(
      { title: "musubi-passkey" },
      {
        status: "failed",
        attachments: [{ name: RECORD_ATTACHMENT, contentType: "application/json", body }],
      },
    );
    expect(record.status).toBe("failed");
    expect(record.flow).toBe("musubi-passkey");
    expect(record.steps).toEqual(["a"]);
  });
});
