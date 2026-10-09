import { describe, expect, it } from "bun:test";

import { EmailError, EmailService, type SendEmailInput } from "@shared/email";
import { Effect, Exit, Layer } from "effect";

import { reconcileBucketName, sendReconcileAlert } from "../../src/lib/reconcile-alert-email";
import { captureLogs } from "../test-helpers/capture-logs";

/** An email service whose first `failures` sends fail, recording every send. */
function emailService(failures = 0) {
  const calls: SendEmailInput[] = [];
  const layer = Layer.succeed(EmailService, {
    send: (msg: SendEmailInput) =>
      Effect.suspend(() => {
        calls.push(msg);
        return calls.length <= failures
          ? Effect.fail(new EmailError({ reason: "rate_limited" }))
          : Effect.void;
      }),
  });
  return { calls, layer };
}

const held = {
  kind: "held",
  bucket: "sheets",
  referencingRows: 40,
  previousRows: 100,
  heldRuns: 1,
  runsLeft: 6,
} as const;

describe("sendReconcileAlert", () => {
  it("sends one counts-only alert naming the tier's bucket", async () => {
    const { calls, layer } = emailService();
    const exit = await Effect.runPromiseExit(
      sendReconcileAlert({ to: "ops@example.test", env: "production", alert: held }).pipe(
        Effect.provide(layer),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual([
      {
        template: "r2-reconcile-alert",
        to: "ops@example.test",
        data: { ...held, env: "production", bucket: "cire-sheets" },
      },
    ]);
  });

  it("names the dev buckets on dev, and sends a tier-wide stop as it is", async () => {
    const { calls, layer } = emailService();
    await Effect.runPromise(
      Effect.all([
        sendReconcileAlert({
          to: "ops@example.test",
          env: "dev",
          alert: { kind: "stopped", bucket: "assets", stoppedDays: 2 },
        }),
        sendReconcileAlert({ to: "ops@example.test", env: "dev", alert: { kind: "disabled" } }),
      ]).pipe(Effect.provide(layer)),
    );
    expect(calls.map((c) => c.data)).toEqual([
      { kind: "stopped", env: "dev", bucket: "cire-assets-dev", stoppedDays: 2 },
      { kind: "disabled", env: "dev" },
    ]);
  });

  it("tries again after a failed send", async () => {
    const { calls, layer } = emailService(1);
    const logs = await captureLogs(() =>
      Effect.runPromise(
        sendReconcileAlert(
          { to: "ops@example.test", env: "production", alert: held },
          { retryDelayMs: 0 },
        ).pipe(Effect.provide(layer)),
      ),
    );
    expect(calls).toHaveLength(2);
    expect(logs).not.toContain("alert send failed");
  });

  it("gives up after three attempts, logs it as an error, and never fails", async () => {
    const { calls, layer } = emailService(5);
    let ok = false;
    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        sendReconcileAlert(
          { to: "ops@example.test", env: "production", alert: held },
          { retryDelayMs: 0 },
        ).pipe(Effect.provide(layer)),
      );
      ok = Exit.isSuccess(exit);
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(logs).toContain("r2 reconcile alert send failed");
  });
});

describe("sendReconcileAlert when the email layer throws", () => {
  it("logs the defect and never fails, so a broken transport cannot fail the cron", async () => {
    let calls = 0;
    const layer = Layer.succeed(EmailService, {
      send: () => {
        calls += 1;
        throw new Error("transport exploded");
      },
    });
    let ok = false;
    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        sendReconcileAlert(
          { to: "ops@example.test", env: "production", alert: { kind: "disabled" } },
          { retryDelayMs: 0 },
        ).pipe(Effect.provide(layer)),
      );
      ok = Exit.isSuccess(exit);
    });
    expect(ok).toBe(true);
    expect(calls).toBe(1);
    expect(logs).toContain("r2 reconcile alert send failed");
    expect(logs).toContain("defect");
  });
});

describe("reconcileBucketName", () => {
  it("matches the bucket each tier binds in wrangler.toml", async () => {
    type Buckets = { r2_buckets: Array<{ binding: string; bucket_name: string }> };
    const toml = Bun.TOML.parse(
      await Bun.file(new URL("../../wrangler.toml", import.meta.url)).text(),
    ) as { env: Record<"dev" | "production", Buckets> };
    for (const env of ["dev", "production"] as const) {
      const named = (binding: string) =>
        toml.env[env].r2_buckets.find((b) => b.binding === binding)?.bucket_name;
      expect(reconcileBucketName("sheets", env)).toBe(named("SHEETS")!);
      expect(reconcileBucketName("assets", env)).toBe(named("ASSETS")!);
    }
  });
});
