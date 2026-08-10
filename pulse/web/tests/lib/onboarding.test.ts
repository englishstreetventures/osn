// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeOnboarding,
  fetchOnboardingStatus,
  isOnboardingResolvedThisSession,
  markOnboardingResolvedThisSession,
  requestLocationPermission,
  requestNotificationPermission,
} from "../../src/lib/onboarding";

const mockMeOnboardingGet = vi.fn();
const mockMeOnboardingCompletePost = vi.fn();
vi.mock("../../src/lib/api", () => ({
  api: {
    me: {
      onboarding: {
        get: (...args: unknown[]) => mockMeOnboardingGet(...args),
        complete: {
          post: (...args: unknown[]) => mockMeOnboardingCompletePost(...args),
        },
      },
    },
  },
}));

function stubGeolocation(impl: PositionCallback | { code: number }) {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      geolocation: {
        getCurrentPosition: (success: PositionCallback, error?: PositionErrorCallback) => {
          if (typeof impl === "function") {
            impl({} as GeolocationPosition);
            success({} as GeolocationPosition);
          } else {
            error?.({
              code: impl.code,
              PERMISSION_DENIED: 1,
              POSITION_UNAVAILABLE: 2,
              TIMEOUT: 3,
              message: "",
            } as GeolocationPositionError);
          }
        },
      },
    },
    writable: true,
    configurable: true,
  });
}

describe("requestLocationPermission", () => {
  const origNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: origNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("returns 'granted' on a successful fix", async () => {
    stubGeolocation(() => undefined);
    expect(await requestLocationPermission()).toBe("granted");
  });

  it("returns 'denied' when the user denies the permission prompt", async () => {
    stubGeolocation({ code: 1 });
    expect(await requestLocationPermission()).toBe("denied");
  });

  it("returns 'prompt' for transient errors (timeout, position unavailable)", async () => {
    stubGeolocation({ code: 3 });
    expect(await requestLocationPermission()).toBe("prompt");
  });

  it("returns 'unsupported' when the geolocation API is missing", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      writable: true,
      configurable: true,
    });
    expect(await requestLocationPermission()).toBe("unsupported");
  });
});

function stubNotification(perm: NotificationPermission, reqResult?: NotificationPermission) {
  // Use an object literal (not a class) — the spec only requires
  // `.permission` + `.requestPermission` on the constructor and oxlint's
  // no-extraneous-class rule rejects a static-only class.
  const mockNotification = {
    permission: perm,
    requestPermission: vi.fn(() => Promise.resolve(reqResult ?? perm)),
  };
  (globalThis as { Notification?: unknown }).Notification = mockNotification;
}

describe("requestNotificationPermission", () => {
  const origNotification = (globalThis as { Notification?: unknown }).Notification;

  afterEach(() => {
    if (origNotification === undefined) {
      delete (globalThis as { Notification?: unknown }).Notification;
    } else {
      (globalThis as { Notification?: unknown }).Notification = origNotification;
    }
  });

  it("returns 'granted' when permission is already granted (no extra prompt)", async () => {
    stubNotification("granted");
    expect(await requestNotificationPermission()).toBe("granted");
  });

  it("returns 'denied' when permission is already denied", async () => {
    stubNotification("denied");
    expect(await requestNotificationPermission()).toBe("denied");
  });

  it("returns 'granted' when the prompt result is granted", async () => {
    stubNotification("default", "granted");
    expect(await requestNotificationPermission()).toBe("granted");
  });

  it("maps 'default' result to 'prompt'", async () => {
    stubNotification("default", "default");
    expect(await requestNotificationPermission()).toBe("prompt");
  });

  it("returns 'unsupported' when the Notification API is missing", async () => {
    delete (globalThis as { Notification?: unknown }).Notification;
    expect(await requestNotificationPermission()).toBe("unsupported");
  });
});

describe("session-skip helpers", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("round-trips the skip flag through sessionStorage", () => {
    expect(isOnboardingResolvedThisSession()).toBe(false);
    markOnboardingResolvedThisSession();
    expect(isOnboardingResolvedThisSession()).toBe(true);
  });

  it("does not throw when sessionStorage is unavailable", () => {
    const orig = globalThis.sessionStorage;
    Object.defineProperty(globalThis, "sessionStorage", {
      value: {
        getItem: () => {
          throw new Error("unavailable");
        },
        setItem: () => {
          throw new Error("unavailable");
        },
      },
      writable: true,
      configurable: true,
    });
    expect(() => markOnboardingResolvedThisSession()).not.toThrow();
    expect(isOnboardingResolvedThisSession()).toBe(false);
    Object.defineProperty(globalThis, "sessionStorage", {
      value: orig,
      writable: true,
      configurable: true,
    });
  });
});

describe("fetchOnboardingStatus", () => {
  beforeEach(() => {
    mockMeOnboardingGet.mockReset();
  });

  it("returns null when no token is provided (skips the network call)", async () => {
    expect(await fetchOnboardingStatus(null)).toBeNull();
    expect(mockMeOnboardingGet).not.toHaveBeenCalled();
  });

  it("returns null on transport error", async () => {
    mockMeOnboardingGet.mockResolvedValueOnce({ data: null, error: { value: "boom" } });
    expect(await fetchOnboardingStatus("tok")).toBeNull();
  });

  it("returns the status payload on success", async () => {
    mockMeOnboardingGet.mockResolvedValueOnce({
      data: {
        completedAt: null,
        interests: [],
        notificationsOptIn: false,
        eventRemindersOptIn: false,
        notificationsPerm: "prompt",
        locationPerm: "prompt",
      },
      error: null,
    });
    const status = await fetchOnboardingStatus("tok");
    expect(status?.completedAt).toBeNull();
    expect(status?.interests).toEqual([]);
  });
});

describe("completeOnboarding", () => {
  const validPayload = {
    interests: ["music"] as const,
    notificationsOptIn: true,
    eventRemindersOptIn: false,
    notificationsPerm: "granted" as const,
    locationPerm: "granted" as const,
  };

  beforeEach(() => {
    mockMeOnboardingCompletePost.mockReset();
  });

  it("returns the status payload on success", async () => {
    const completedAt = new Date().toISOString();
    mockMeOnboardingCompletePost.mockResolvedValueOnce({
      data: {
        completedAt,
        interests: ["music"],
        notificationsOptIn: true,
        eventRemindersOptIn: false,
        notificationsPerm: "granted",
        locationPerm: "granted",
      },
      error: null,
    });
    const status = await completeOnboarding("tok", { ...validPayload });
    expect(status.completedAt).toBe(completedAt);
    expect(status.interests).toEqual(["music"]);
  });

  it("throws with the stringified server error when error.value is present", async () => {
    mockMeOnboardingCompletePost.mockResolvedValueOnce({
      data: null,
      error: { value: { error: "Invalid onboarding payload" } },
    });
    await expect(completeOnboarding("tok", { ...validPayload })).rejects.toThrow(
      /Invalid onboarding payload/,
    );
  });

  it("throws a generic message when error is present but lacks .value", async () => {
    mockMeOnboardingCompletePost.mockResolvedValueOnce({
      data: null,
      error: "boom",
    });
    await expect(completeOnboarding("tok", { ...validPayload })).rejects.toThrow(
      "Failed to complete onboarding",
    );
  });

  it("throws when the success response is missing the completedAt field", async () => {
    mockMeOnboardingCompletePost.mockResolvedValueOnce({
      data: { somethingElse: 1 },
      error: null,
    });
    await expect(completeOnboarding("tok", { ...validPayload })).rejects.toThrow(
      "Unexpected onboarding response",
    );
  });

  it("forwards the bearer token in the Authorization header", async () => {
    mockMeOnboardingCompletePost.mockResolvedValueOnce({
      data: {
        completedAt: new Date().toISOString(),
        interests: [],
        notificationsOptIn: false,
        eventRemindersOptIn: false,
        notificationsPerm: "prompt",
        locationPerm: "prompt",
      },
      error: null,
    });
    await completeOnboarding("the-token", { ...validPayload });
    const [, opts] = mockMeOnboardingCompletePost.mock.calls[0]!;
    expect((opts as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer the-token",
    );
  });
});
