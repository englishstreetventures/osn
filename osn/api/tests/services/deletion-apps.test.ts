import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect } from "vitest";

import { _resetOutboundKeyForTests } from "../../src/lib/outbound-arc";
import {
  deletionAppsConfig,
  DeletionAppsConfigError,
  endAppSessions,
  previewDeletionApps,
} from "../../src/services/deletion-apps";
import { createTestLayer } from "../helpers/db";
import { appStandIns, type AppAnswer } from "../helpers/deletion-apps";

/**
 * Where the deletion reaches each app, and what one app's preview answer can
 * do to the deletion: an answer outside the contract, or none in time, holds
 * the deletion as `could_not_check`; an app the tier does not run is skipped.
 */

afterEach(() => _resetOutboundKeyForTests());

describe("deletionAppsConfig", () => {
  it("reads each app's URL and the apps declared absent", () => {
    const config = deletionAppsConfig({
      OSN_ENV: "production",
      ZAP_API_URL: "https://zap.example/",
      OSN_DELETION_ABSENT_APPS: " pulse ",
      INTERNAL_SERVICE_SECRET: "s",
    });
    expect(config).toEqual({
      local: false,
      urls: { zap: "https://zap.example" },
      absent: new Set(["pulse"]),
      arc: { kidSecret: "s" },
    });
  });

  it.each([
    ["an absent name that is no app", { OSN_DELETION_ABSENT_APPS: "pusle" }],
    [
      "an app both given a URL and declared absent",
      { ZAP_API_URL: "https://zap.example", OSN_DELETION_ABSENT_APPS: "zap" },
    ],
    ["a deployed tier with no INTERNAL_SERVICE_SECRET", { OSN_ENV: "dev" }],
  ])("refuses %s", (_label, env) => {
    expect(() => deletionAppsConfig(env)).toThrow(DeletionAppsConfigError);
  });

  it("treats an unset or local OSN_ENV as a local run, as the rest of osn-api does", () => {
    expect(deletionAppsConfig({}).local).toBe(true);
    expect(deletionAppsConfig({ OSN_ENV: "local" }).local).toBe(true);
    expect(deletionAppsConfig({ OSN_ENV: "staging", INTERNAL_SERVICE_SECRET: "s" }).local).toBe(
      false,
    );
  });
});

describe("previewDeletionApps", () => {
  const input = { accountId: "acc_1", profileIds: ["usr_1"], deletesAt: 1_900_000_000 };
  const action = {
    id: "pulse:event:evt_1",
    kind: "events_hosted",
    label: "You host Picnic.",
    choices: [
      { choice: "cancel", description: "Shown as cancelled.", erasedOn: 1_901_000_000 },
      { choice: "delete", description: "Deleted.", erasedOn: null },
    ],
    defaultChoice: "cancel",
    link: null,
  };
  let pulseAnswer: () => AppAnswer | undefined = () => undefined;
  const apps = appStandIns((call) =>
    call.app === "pulse" && call.path === "/internal/account-deletion-preview"
      ? pulseAnswer()
      : undefined,
  );
  afterAll(() => apps.stop());

  it.effect("asks every app with the account, its profiles and the date, signed for that app", () =>
    Effect.gen(function* () {
      pulseAnswer = () => ({ body: { openActions: [action] } });
      const before = apps.calls.length;
      const previews = yield* previewDeletionApps(apps.config(), input);
      expect(previews).toEqual([
        { app: "pulse", status: "checked", actions: [action] },
        { app: "zap", status: "checked", actions: [] },
      ]);
      const calls = apps.calls.slice(before);
      expect(calls.map((call) => [call.app, call.path])).toEqual(
        expect.arrayContaining([
          ["pulse", "/internal/account-deletion-preview"],
          ["zap", "/internal/account-deletion-preview"],
        ]),
      );
      for (const call of calls) {
        expect(call.body).toEqual(input);
        expect(call.authorization).toMatch(/^ARC /);
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("holds the deletion when an app answers outside the contract or not at all", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, () => AppAnswer]> = [
        ["an error status", () => ({ status: 500, body: { error: "boom" } })],
        ["a missing route", () => ({ status: 404, body: { error: "not found" } })],
        ["an answer outside the contract", () => ({ body: { actions: [] } })],
        [
          "an action of another app",
          () => ({ body: { openActions: [{ ...action, id: "zap:x" }] } }),
        ],
        ["the same action twice", () => ({ body: { openActions: [action, action] } })],
        [
          "a default that is not a choice",
          () => ({ body: { openActions: [{ ...action, defaultChoice: "keep" }] } }),
        ],
        [
          "a link that is not https",
          () => ({ body: { openActions: [{ ...action, link: "http://pulse.example/e/1" }] } }),
        ],
      ];
      for (const [label, answer] of cases) {
        pulseAnswer = answer;
        const previews = yield* previewDeletionApps(apps.config(), input);
        expect({ label, preview: previews[0] }).toEqual({
          label,
          preview: { app: "pulse", status: "could_not_check" },
        });
        expect(previews[1]).toMatchObject({ app: "zap", status: "checked" });
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("skips an app the tier does not run, without asking it", () =>
    Effect.gen(function* () {
      pulseAnswer = () => undefined;
      const before = apps.calls.length;
      const config = apps.config();
      const previews = yield* previewDeletionApps(
        { ...config, urls: { zap: config.urls.zap! }, absent: new Set(["pulse"]), local: false },
        input,
      );
      expect(previews[0]).toEqual({ app: "pulse", status: "skipped" });
      expect(apps.calls.slice(before).some((call) => call.app === "pulse")).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "on a deployed tier, an app with neither a URL nor a declaration cannot be checked",
    () =>
      Effect.gen(function* () {
        const config = apps.config();
        const previews = yield* previewDeletionApps(
          { ...config, urls: { zap: config.urls.zap! }, local: false },
          input,
        );
        expect(previews[0]).toEqual({ app: "pulse", status: "could_not_check" });
      }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("endAppSessions", () => {
  let fail = false;
  const apps = appStandIns((call) =>
    call.path === "/internal/account-sessions/revoke" && fail ? { status: 503 } : undefined,
  );
  afterAll(() => apps.stop());

  it.effect("asks only the apps that keep their own sessions, with the profiles", () =>
    Effect.gen(function* () {
      fail = false;
      const before = apps.calls.length;
      yield* endAppSessions(apps.config(), "acc_1", ["usr_1", "usr_2"]);
      const calls = apps.calls.slice(before);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        app: "pulse",
        path: "/internal/account-sessions/revoke",
        body: { accountId: "acc_1", profileIds: ["usr_1", "usr_2"] },
      });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a refused call is absorbed: the soft delete stands", () =>
    Effect.gen(function* () {
      fail = true;
      const before = apps.calls.length;
      const outcome = yield* Effect.result(endAppSessions(apps.config(), "acc_2", ["usr_1"]));
      expect(outcome._tag).toBe("Success");
      expect(apps.calls.length).toBe(before + 1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("calls nothing when the app is skipped", () =>
    Effect.gen(function* () {
      const before = apps.calls.length;
      yield* endAppSessions({ ...apps.config(), urls: {} }, "acc_1", ["usr_1"]);
      expect(apps.calls.length).toBe(before);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
