import { describe, expect, it } from "vitest";

import { clearSeen, writeSeen } from "../src/boot";

const KEY = "c".repeat(64);

describe("seen flag writes", () => {
  const throwingStorage = {
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError");
    },
  };

  it("swallow a storage that throws on write", () => {
    expect(() => writeSeen(KEY, "1", () => throwingStorage)).not.toThrow();
    expect(() => clearSeen(KEY, () => throwingStorage)).not.toThrow();
  });

  it("swallow a storage that cannot even be reached", () => {
    const unreachable = () => {
      throw new Error("SecurityError: access to localStorage is denied");
    };
    expect(() => writeSeen(KEY, "failed", unreachable)).not.toThrow();
    expect(() => clearSeen(KEY, unreachable)).not.toThrow();
  });
});
