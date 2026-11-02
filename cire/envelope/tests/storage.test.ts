import { describe, expect, it } from "vitest";

import { writeSeen } from "../src/boot";

const KEY = "c".repeat(64);

describe("seen flag write", () => {
  const throwingStorage = {
    setItem() {
      throw new Error("QuotaExceededError");
    },
  };

  it("swallows a storage that throws on write", () => {
    expect(() => writeSeen(KEY, "1", () => throwingStorage)).not.toThrow();
  });

  it("swallows a storage that cannot even be reached", () => {
    const unreachable = () => {
      throw new Error("SecurityError: access to localStorage is denied");
    };
    expect(() => writeSeen(KEY, "failed", unreachable)).not.toThrow();
  });
});
