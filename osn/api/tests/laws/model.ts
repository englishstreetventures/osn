/**
 * The deletion model, compiled from tools/deletion-laws/model.bend, and the
 * helpers that turn JavaScript values into Bend's and back. The laws proved
 * about it are in tools/deletion-laws/LAWS.bend; the tests beside this file
 * run the same events through it and through osn-api's services and fail
 * when the two disagree.
 */
import model, { type List } from "../../../../tools/deletion-laws/model.mjs";

export type * from "../../../../tools/deletion-laws/model.mjs";
export { model };

export const list = <T>(items: ReadonlyArray<T>): List<T> =>
  items.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

export const array = <T>(items: List<T>): T[] => {
  const out: T[] = [];
  let cell = items;
  while (cell.$ === "Con") {
    out.push(cell.head);
    cell = cell.tail;
  }
  return out;
};

/**
 * A fixed-seed generator (mulberry32), so every run draws the same traces and
 * a failure names the seed that reproduces it.
 */
export const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    int: (below: number): number => Math.floor(next() * below),
    pick: <T>(items: ReadonlyArray<T>): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number): boolean => next() < p,
  };
};
