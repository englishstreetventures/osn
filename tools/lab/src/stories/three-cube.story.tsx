import { createEffect } from "solid-js";
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  TorusKnotGeometry,
  type BufferGeometry,
} from "three";

import { ThreeCanvas } from "../lab/three.tsx";
import type { Story, StoryArgs } from "../lab/types.ts";

// `headless: false` — every story here builds a `WebGLRenderer`, which needs a
// GPU context no headless DOM provides. The smoke test imports the file and
// stops there.
export const meta = { title: "lab/three", layout: "fullscreen" as const, headless: false };

interface SpinArgs extends StoryArgs {
  figure: "cube" | "knot";
  color: string;
  speed: number;
  wireframe: boolean;
  metalness: number;
  roughness: number;
}

/**
 * Shows the pattern for driving a three.js scene from live args: build the
 * objects once in `setup`, then a `createEffect` per arg pushes changes onto
 * the material. Nothing is rebuilt, so dragging a slider stays at 60fps.
 */
export const Spin: Story<SpinArgs> = {
  args: {
    figure: "knot",
    color: "#7c5cff",
    speed: 0.6,
    wireframe: false,
    metalness: 0.3,
    roughness: 0.25,
  },
  controls: {
    figure: { kind: "select", options: ["cube", "knot"] },
    speed: { kind: "range", min: 0, max: 3, step: 0.05 },
    metalness: { kind: "range", min: 0, max: 1, step: 0.05 },
    roughness: { kind: "range", min: 0, max: 1, step: 0.05 },
  },
  render: (args) => (
    <ThreeCanvas
      setup={({ scene, camera, onFrame, onDispose }) => {
        const material = new MeshStandardMaterial({ color: args.color });
        const cube = new BoxGeometry(1.6, 1.6, 1.6);
        const knot = new TorusKnotGeometry(0.9, 0.3, 160, 24);
        const mesh = new Mesh<BufferGeometry, MeshStandardMaterial>(knot, material);
        scene.add(mesh);
        // Only the geometry currently on the mesh is reachable from the
        // scene, so the teardown walk would miss the other one.
        onDispose(() => {
          cube.dispose();
          knot.dispose();
        });

        const key = new DirectionalLight(0xffffff, 2.4);
        key.position.set(3, 4, 5);
        scene.add(key, new AmbientLight(0xffffff, 0.4));
        camera.position.set(0, 0, 4.5);

        createEffect(() => {
          mesh.geometry = args.figure === "cube" ? cube : knot;
        });
        createEffect(() => material.color.set(args.color));
        createEffect(() => {
          material.wireframe = args.wireframe;
          material.metalness = args.metalness;
          material.roughness = args.roughness;
        });

        onFrame(({ delta }) => {
          mesh.rotation.y += delta * args.speed;
          mesh.rotation.x += delta * args.speed * 0.4;
        });
      }}
    />
  ),
};
