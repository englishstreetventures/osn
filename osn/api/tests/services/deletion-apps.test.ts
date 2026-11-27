import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, vi } from "vitest";

import { _resetOutboundKeyForTests } from "../../src/lib/outbound-arc";
import * as metrics from "../../src/metrics";
import {
  appTarget,
  deletionAppsConfig,
  DeletionAppsConfigError,
  endAppSessions,
  previewDeletionApps,
} from "../../src/services/deletion-apps";
import { createTestLayer } from "../helpers/db";
import { appStandIns, arcClaims, type AppAnswer } from "../helpers/deletion-apps";

/**
 * Where the deletion reaches each app, and what one app's preview answer can
 * do to the deletion: an answer outside the contract, or none in time, holds
 * the deletion as `could_not_check`; an app the tier does not run is skipped.
 */

afterEach(() => {
  _resetOutboundKeyForTests();
  vi.restoreAllMocks();
});

const SECRET = "i".repeat(32);
const KID_SECRET = "k".repeat(32);

describe("deletionAppsConfig", () => {
  it("reads each app's URL and the apps declared absent", () => {
    const config = deletionAppsConfig({
      OSN_ENV: "production",
      ZAP_API_URL: "https://zap.example/",
      CIRE_API_URL: "https://api.cire.example/",
      OSN_DELETION_ABSENT_APPS: " pulse ",
      INTERNAL_SERVICE_SECRET: SECRET,
      OSN_ARC_KID_SECRET: KID_SECRET,
    });
    expect(config).toEqual({
      local: false,
      urls: { zap: "https://zap.example", cire: "https://api.cire.example" },
      absent: new Set(["pulse"]),
      arc: { kidSecret: KID_SECRET, serviceSecret: SECRET },
      previewTimeoutMs: 8_000,
      fanoutTimeoutMs: 10_000,
    });
  });

  it("takes plain HTTP to this machine on a local run", () => {
    expect(deletionAppsConfig({ PULSE_API_URL: "http://localhost:3001" }).urls).toEqual({
      pulse: "http://localhost:3001",
    });
  });

  it.each([
    ["an absent name that is no app", { OSN_DELETION_ABSENT_APPS: "pusle" }],
    [
      "an app both given a URL and declared absent",
      { ZAP_API_URL: "https://zap.example", OSN_DELETION_ABSENT_APPS: "zap" },
    ],
    ["a deployed tier with no INTERNAL_SERVICE_SECRET", { OSN_ENV: "dev" }],
    [
      "a deployed tier with OSN_ARC_KID_SECRET but no INTERNAL_SERVICE_SECRET",
      { OSN_ENV: "dev", OSN_ARC_KID_SECRET: KID_SECRET },
    ],
    [
      "a plain-HTTP app URL on a deployed tier",
      { OSN_ENV: "dev", INTERNAL_SERVICE_SECRET: SECRET, ZAP_API_URL: "http://zap.example" },
    ],
    [
      "plain HTTP even to this machine on a deployed tier",
      { OSN_ENV: "dev", INTERNAL_SERVICE_SECRET: SECRET, ZAP_API_URL: "http://localhost:3002" },
    ],
    ["plain HTTP to another host on a local run", { ZAP_API_URL: "http://zap.example" }],
    [
      "a plain-HTTP cire URL on a deployed tier",
      { OSN_ENV: "dev", INTERNAL_SERVICE_SECRET: SECRET, CIRE_API_URL: "http://api.cire.example" },
    ],
    ["an app URL that does not parse", { ZAP_API_URL: "zap.example" }],
  ])("refuses %s", (_label, env) => {
    expect(() => deletionAppsConfig(env)).toThrow(DeletionAppsConfigError);
  });

  it("fails closed for cire on a deployed tier with no CIRE_API_URL, and skips it on a local run", () => {
    const deployed = deletionAppsConfig({
      OSN_ENV: "production",
      ZAP_API_URL: "https://zap.example",
      OSN_DELETION_ABSENT_APPS: "pulse",
      INTERNAL_SERVICE_SECRET: SECRET,
    });
    expect(appTarget(deployed, "cire")).toEqual({ kind: "unconfigured" });
    expect(appTarget(deletionAppsConfig({}), "cire")).toEqual({ kind: "skip" });
  });

  it("treats an unset or local OSN_ENV as a local run, as the rest of osn-api does", () => {
    expect(deletionAppsConfig({}).local).toBe(true);
    expect(deletionAppsConfig({ OSN_ENV: "local" }).local).toBe(true);
    expect(deletionAppsConfig({ OSN_ENV: "staging", INTERNAL_SERVICE_SECRET: SECRET }).local).toBe(
      false,
    );
  });
});

describe("previewDeletionApps", () => {
  const input = { profileIds: ["usr_1"], deletesAt: 1_900_000_000 };
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

  it.effect(
    "asks every app with the profiles and the date, never the account, signed for that app",
    () =>
      Effect.gen(function* () {
        pulseAnswer = () => ({ body: { openActions: [action] } });
        const before = apps.calls.length;
        const previews = yield* previewDeletionApps(apps.config(), input);
        expect(previews).toEqual([
          { app: "pulse", status: "checked", actions: [action] },
          { app: "zap", status: "checked", actions: [] },
          { app: "cire", status: "checked", actions: [] },
        ]);
        const calls = apps.calls.slice(before);
        expect(calls.map((call) => [call.app, call.path])).toEqual(
          expect.arrayContaining([
            ["pulse", "/internal/account-deletion-preview"],
            ["zap", "/internal/account-deletion-preview"],
            ["cire", "/internal/account-deletion-preview"],
          ]),
        );
        for (const call of calls) {
          expect(call.body).toEqual(input);
          expect(call.authorization).toMatch(/^ARC /);
          expect(arcClaims(call.authorization)).toMatchObject({
            aud: `${call.app}-api`,
            scope: "account:deletion-preview",
          });
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

  it.effect("follows an http link to this machine on a local run only", () =>
    Effect.gen(function* () {
      // The local and E2E stacks run on http over loopback: their links work
      // there, and a deployed tier still holds the deletion on any http link.
      const local = { ...action, link: "http://localhost:4322/#/w/wed_1/settings/export" };
      pulseAnswer = () => ({ body: { openActions: [local] } });
      const config = apps.config();
      expect((yield* previewDeletionApps({ ...config, local: true }, input))[0]).toEqual({
        app: "pulse",
        status: "checked",
        actions: [local],
      });
      expect((yield* previewDeletionApps({ ...config, local: false }, input))[0]).toEqual({
        app: "pulse",
        status: "could_not_check",
      });
      for (const link of ["http://localhost.example/e/1", "javascript:alert(1)"]) {
        pulseAnswer = () => ({ body: { openActions: [{ ...action, link }] } });
        expect({
          link,
          preview: (yield* previewDeletionApps({ ...config, local: true }, input))[0],
        }).toEqual({ link, preview: { app: "pulse", status: "could_not_check" } });
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("holds the deletion when an app does not answer in time, and counts a timeout", () => {
    // The timeout is a real `AbortSignal.timeout`, so only pulse is called (a
    // local tier skips an app with no URL), and its answer waits on a gate the
    // case opens when it ends: nothing races the 50 ms budget, and no timer
    // outlives the case.
    const gate = Promise.withResolvers<void>();
    return Effect.gen(function* () {
      const counted = vi.spyOn(metrics, "metricAccountDeletionAppPreview");
      pulseAnswer = () => ({ until: gate.promise });
      const config = apps.config({ previewTimeoutMs: 50 });
      const previews = yield* previewDeletionApps(
        { ...config, urls: { pulse: config.urls.pulse! } },
        input,
      );
      expect(previews[0]).toEqual({ app: "pulse", status: "could_not_check" });
      expect(counted).toHaveBeenCalledWith("pulse", "timeout");
    }).pipe(Effect.ensuring(Effect.sync(() => gate.resolve())), Effect.provide(createTestLayer()));
  });

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
      yield* endAppSessions(apps.config(), ["usr_1", "usr_2"]);
      const calls = apps.calls.slice(before);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ app: "pulse", path: "/internal/account-sessions/revoke" });
      expect(calls[0]!.body).toEqual({ profileIds: ["usr_1", "usr_2"] });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a refused call is absorbed: the soft delete stands", () =>
    Effect.gen(function* () {
      fail = true;
      const before = apps.calls.length;
      const outcome = yield* Effect.result(endAppSessions(apps.config(), ["usr_1"]));
      expect(outcome._tag).toBe("Success");
      expect(apps.calls.length).toBe(before + 1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("calls nothing when the app is skipped", () =>
    Effect.gen(function* () {
      const before = apps.calls.length;
      yield* endAppSessions({ ...apps.config(), urls: {} }, ["usr_1"]);
      expect(apps.calls.length).toBe(before);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
