/**
 * The wax seal on the envelope's flap, and the three ways it breaks.
 *
 * This is the placeholder: a disc of crimson wax with an irregular rim, a
 * pressed ring and a raised "C". The finished seal replaces this module and
 * keeps its interface, {@link buildSeal} and {@link Seal}, which is all the
 * scene knows of it.
 *
 * The seal does not keep time. The scene calls {@link Seal.update} every frame
 * with animation seconds, already multiplied by the playback rate, so a tap
 * that speeds the opening up speeds the break too.
 */

import {
  ExtrudeGeometry,
  type ExtrudeGeometryOptions,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `Shape` is three's own class name; it is renamed here for its role
  Shape as WaxOutline,
  Vector2,
} from "three";

import type { BreakStyle } from "../index";
import { sealFaceTextures } from "../scene/paint";
import { centroid, crumbs, type Outline, rim, splitHalves } from "./shapes";

export interface Seal {
  /** The seal, centred on its own origin, facing +z. The scene places it on the flap's tip. */
  readonly group: Group;
  /**
   * Starts the break. Resolves once the seal no longer holds the flap shut,
   * which is when the scene may open it; pieces may go on falling after that.
   */
  break(style: BreakStyle): Promise<void>;
  /** Advances the seal's motion by `dt` animation seconds. */
  update(dt: number): void;
  /** Fades the whole seal with the envelope as the card takes the screen. */
  setOpacity(alpha: number): void;
  dispose(): void;
}

interface SealOptions {
  /** World units (CSS pixels). */
  readonly radius: number;
  /** The flap's hinge: a piece that stays on the flap is attached here and opens with it. */
  readonly flap: Object3D;
  /** Draw order for the seal while the flap is closed, and for a piece on the flap once it is open. */
  readonly layers: { readonly closed: number; readonly open: number };
  /** The CSS font the die's letter is drawn in. */
  readonly font: string;
}

const WAX = "#7d1622";
const WAX_SIDE = "#5e0f19";
const GRAVITY = 2400;

/** One piece of wax: its mesh, how it moves, and how faded it is. */
interface Piece {
  readonly mesh: Mesh;
  /** Its outline, for which way it flies. */
  readonly outline: Outline;
  /** Velocity and spin, in units and radians per second. */
  readonly velocity: [number, number, number];
  readonly spin: [number, number, number];
  falling: boolean;
  fade: number;
}

export function buildSeal(options: SealOptions): Seal {
  const r = options.radius;
  const depth = r * 0.2;
  const bevel = r * 0.07;
  const face = sealFaceTextures(WAX, "C", options.font);
  const faceMaterial = new MeshStandardMaterial({
    map: face.map,
    bumpMap: face.bump,
    bumpScale: 2.2,
    roughness: 0.38,
    metalness: 0,
    // Drawn in the scene's one transparent list, in its layer (see `scene.ts`).
    transparent: true,
  });
  const sideMaterial = new MeshStandardMaterial({
    color: WAX_SIDE,
    roughness: 0.5,
    metalness: 0,
    transparent: true,
  });

  const extrude: ExtrudeGeometryOptions = {
    depth,
    curveSegments: 1,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    // The face samples the drawing by position on the seal, so a piece shows
    // its own part of the ring and the letter.
    UVGenerator: {
      generateTopUV(_geometry, vertices, a, b, c) {
        const uv = (i: number) =>
          new Vector2(vertices[i * 3]! / (2 * r) + 0.5, vertices[i * 3 + 1]! / (2 * r) + 0.5);
        return [uv(a), uv(b), uv(c)];
      },
      generateSideWallUV() {
        return [new Vector2(), new Vector2(), new Vector2(), new Vector2()];
      },
    },
  };

  const group = new Group();
  let alpha = 1;
  let pieces: Piece[] = [];
  /** A peel's hinge, removed with its piece. */
  let pivot: Group | null = null;
  let elapsed = 0;
  let style: BreakStyle | null = null;
  let release: (() => void) | null = null;
  let releaseAt = 0;

  const makePiece = (outline: Outline): Piece => {
    const profile = new WaxOutline(outline.map(([x, y]) => new Vector2(x, y)));
    const mesh = new Mesh(new ExtrudeGeometry(profile, extrude), [
      faceMaterial.clone(),
      sideMaterial.clone(),
    ]);
    mesh.renderOrder = options.layers.closed;
    return { mesh, outline, velocity: [0, 0, 0], spin: [0, 0, 0], falling: false, fade: 1 };
  };

  const show = (next: Piece[]) => {
    for (const piece of pieces) disposePiece(piece);
    pivot?.removeFromParent();
    pivot = null;
    pieces = next;
    for (const piece of pieces) group.add(piece.mesh);
    applyOpacity();
  };

  const applyOpacity = () => {
    for (const piece of pieces) {
      for (const material of piece.mesh.material as MeshStandardMaterial[]) {
        material.opacity = alpha * piece.fade;
      }
      piece.mesh.visible = alpha * piece.fade > 0.001;
    }
  };

  show([makePiece(rim(r))]);

  const fall = (
    piece: Piece,
    velocity: [number, number, number],
    spin: [number, number, number],
  ) => {
    piece.velocity.splice(0, 3, ...velocity);
    piece.spin.splice(0, 3, ...spin);
    piece.falling = true;
  };

  /** Where each break style is at `t` seconds in, for what is not plain falling. */
  const pose = (t: number) => {
    if (style === "split") {
      // The crack opens: the halves part along the flap's edge, the upper
      // tipping with the flap it now rides, the lower staying on the pocket.
      const k = Math.min(1, t / 0.18);
      const [upper, lower] = pieces;
      if (upper && lower) {
        upper.mesh.rotation.z = 0.05 * k;
        lower.mesh.position.y = -1.2 * k;
        lower.mesh.rotation.z = -0.035 * k;
      }
    } else if (style === "peel") {
      // Lifted from its left edge like a sticker, then let go.
      const piece = pieces[0];
      if (piece && pivot && !piece.falling) {
        const k = Math.min(1, t / 0.28);
        pivot.rotation.y = -1.15 * k * k;
        pivot.position.z = depth + r * 0.5 * k;
        if (k >= 1) fall(piece, [r * 2.2, r * 1.5, r * 2], [1.4, 2.4, 3.1]);
      }
    } else if (style === "crumble") {
      // A shiver, then every crumb flies off its own way.
      if (t < 0.1) {
        pieces.forEach((piece, i) => {
          piece.mesh.position.x = Math.sin(t * 160 + i) * 0.6;
          piece.mesh.position.y = Math.cos(t * 150 + i * 2) * 0.6;
        });
      } else if (!pieces.some((p) => p.falling)) {
        pieces.forEach((piece, i) => {
          const [cx, cy] = centroid(piece.outline);
          const length = Math.hypot(cx, cy) || 1;
          const speed = r * (3.2 + (i % 3) * 0.8);
          fall(
            piece,
            [(cx / length) * speed, (cy / length) * speed + r * 3, r * (2 + (i % 2))],
            [(i % 2 ? 1 : -1) * (3 + i), 2 + i * 0.7, (i % 3 ? -1 : 1) * (4 + i)],
          );
        });
      }
    }
  };

  return {
    group,
    break(next) {
      style = next;
      elapsed = 0;
      if (next === "split") {
        const halves = splitHalves(r);
        const upper = makePiece(halves.upper);
        const lower = makePiece(halves.lower);
        upper.mesh.userData["layers"] = options.layers;
        show([upper, lower]);
        // Rides the flap from here: attach keeps where it is on screen.
        options.flap.attach(upper.mesh);
        releaseAt = 0.18;
      } else if (next === "peel") {
        const whole = makePiece(rim(r));
        show([whole]);
        // Hinged at its left edge, so it lifts from the right like a sticker.
        pivot = new Group();
        pivot.position.x = -r;
        whole.mesh.position.x = r;
        pivot.add(whole.mesh);
        group.add(pivot);
        releaseAt = 0.2;
      } else {
        show(crumbs(r, 6).map(makePiece));
        releaseAt = 0.12;
      }
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    update(dt) {
      if (!style) return;
      elapsed += dt;
      pose(elapsed);
      for (const piece of pieces) {
        if (!piece.falling) continue;
        const target = piece.mesh.parent === group ? piece.mesh : (piece.mesh.parent as Object3D);
        piece.velocity[1] -= GRAVITY * dt;
        target.position.x += piece.velocity[0] * dt;
        target.position.y += piece.velocity[1] * dt;
        target.position.z += piece.velocity[2] * dt;
        target.rotation.x += piece.spin[0] * dt;
        target.rotation.y += piece.spin[1] * dt;
        target.rotation.z += piece.spin[2] * dt;
        piece.fade = Math.max(0, piece.fade - dt * 1.8);
      }
      applyOpacity();
      if (release && elapsed >= releaseAt) {
        release();
        release = null;
      }
    },
    setOpacity(next) {
      // Called every frame; `update` already applies each piece's fade.
      if (next === alpha) return;
      alpha = next;
      applyOpacity();
    },
    dispose() {
      for (const piece of pieces) disposePiece(piece);
      pieces = [];
      pivot?.removeFromParent();
      pivot = null;
      faceMaterial.dispose();
      sideMaterial.dispose();
      face.map.dispose();
      face.bump.dispose();
      release?.();
      release = null;
    },
  };
}

function disposePiece(piece: Piece): void {
  piece.mesh.removeFromParent();
  piece.mesh.geometry.dispose();
  for (const material of piece.mesh.material as MeshStandardMaterial[]) material.dispose();
}
