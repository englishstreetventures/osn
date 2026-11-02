import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { fitDistance, MAX_RATE, nextRate } from "../src/scene/math";

describe("nextRate", () => {
  it("steps 1, 3, 8 and stays at 8", () => {
    const rates = [1];
    for (let i = 0; i < 4; i++) rates.push(nextRate(rates.at(-1)!));
    expect(rates).toEqual([1, 3, 8, 8, 8]);
    expect(MAX_RATE).toBe(8);
  });
});

describe("fitDistance", () => {
  /** Where the plane's corners land in normalised device coordinates. */
  function projectedCorners(width: number, height: number, fov: number) {
    const camera = new PerspectiveCamera(fov, width / height, 1, 100_000);
    camera.position.set(0, 0, fitDistance(height, fov));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const corner = (x: number, y: number) => {
      const v = new Vector3(x, y, 0).project(camera);
      return [Number(v.x.toFixed(9)), Number(v.y.toFixed(9))];
    };
    return [corner(-width / 2, -height / 2), corner(width / 2, height / 2)];
  }

  it.each([
    ["a portrait phone", 412, 839, 35],
    ["a landscape desktop", 1280, 800, 35],
    ["a wide field of view", 390, 844, 60],
  ])("frames a viewport-sized plane exactly on %s", (_name, width, height, fov) => {
    expect(projectedCorners(width, height, fov)).toEqual([
      [-1, -1],
      [1, 1],
    ]);
  });
});
