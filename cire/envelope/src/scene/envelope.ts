/**
 * The paper envelope: a pocket, a top flap hinged on the pocket's top edge,
 * and a soft shadow. Flat layers, so they are drawn without depth testing in a
 * fixed order (`LAYER`); only the seal tests depth, among its own pieces.
 */

import {
  BackSide,
  FrontSide,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  type Texture,
} from "three";

import { flapTexture, pocketTexture, shadowTexture } from "./paint";

/** Draw order. The flap and anything riding it change layer as it passes upright. */
export const LAYER = {
  SHADOW: 0,
  FLAP_OPEN: 2,
  SEAL_ON_OPEN_FLAP: 3,
  CARD_EDGE: 4,
  CARD: 5,
  POCKET: 6,
  FLAP_CLOSED: 7,
  SEAL: 8,
  CARD_LIFTED_EDGE: 10,
  CARD_LIFTED: 11,
} as const;

/** Where things sit, in world units (CSS pixels), from the envelope's centre. */
export interface EnvelopeLayout {
  /** Envelope width and height. */
  readonly width: number;
  readonly height: number;
  /** How far the closed flap's tip reaches down from the top edge. */
  readonly flapDepth: number;
  readonly sealRadius: number;
  /** The seal's centre, on the flap's tip. */
  readonly sealY: number;
  /** The card's size inside the envelope, and its centre at rest and lifted out. */
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly cardRestY: number;
  readonly cardLiftY: number;
  /** The envelope's centre on screen. */
  readonly centreY: number;
}

/**
 * The envelope's size and positions for a viewport. Portrait screens get a
 * portrait envelope opening on its short edge, landscape ones a landscape
 * envelope; either way it takes a little over half the screen's height and
 * sits below centre, leaving room above for the card to rise into.
 */
export function envelopeLayout(viewportWidth: number, viewportHeight: number): EnvelopeLayout {
  const portrait = viewportHeight > viewportWidth;
  const aspect = portrait ? 1 / 1.38 : 1.42;
  let width = portrait ? Math.min(viewportWidth * 0.82, 440) : viewportHeight * 0.56 * aspect;
  let height = width / aspect;
  const maxHeight = viewportHeight * 0.56;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  if (width > viewportWidth * 0.82) {
    width = viewportWidth * 0.82;
    height = width / aspect;
  }
  const flapDepth = Math.min(width * 0.6, height * 0.58);
  const sealRadius = Math.min(width, height) * 0.12;
  const cardWidth = width * 0.9;
  const cardHeight = Math.min(height * 0.9, (cardWidth * viewportHeight) / viewportWidth);
  return {
    width,
    height,
    flapDepth,
    sealRadius,
    sealY: height / 2 - flapDepth + sealRadius * 0.25,
    cardWidth,
    cardHeight,
    cardRestY: -height / 2 + cardHeight / 2 + height * 0.04,
    cardLiftY: height / 2 + cardHeight * 0.1,
    centreY: -viewportHeight * 0.1,
  };
}

export interface EnvelopeModel {
  /** The whole envelope; the scene moves and fades it. */
  readonly group: Group;
  /** The flap's hinge. Things that ride the flap are attached here. */
  readonly flap: Group;
  /** Opens the flap by `angle` radians about its hinge: 0 is sealed, π lies flat open. */
  setFlap(angle: number): void;
  setOpacity(alpha: number): void;
  dispose(): void;
}

function sheet(
  width: number,
  height: number,
  map: Texture,
  layer: number,
  side: typeof FrontSide | typeof BackSide = FrontSide,
): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(width, height),
    new MeshBasicMaterial({ map, transparent: true, depthTest: false, depthWrite: false, side }),
  );
  mesh.renderOrder = layer;
  return mesh;
}

/** Sets the layer of everything riding the flap, by whether it now faces away. */
function layerFlap(flap: Object3D, open: boolean): void {
  flap.traverse((object) => {
    const layers = object.userData["layers"] as { closed: number; open: number } | undefined;
    if (layers) object.renderOrder = open ? layers.open : layers.closed;
  });
}

export function buildEnvelope(
  layout: EnvelopeLayout,
  liner: { ground: string; ink: string },
  texelsPerUnit: number,
): EnvelopeModel {
  const { width, height, flapDepth } = layout;
  const group = new Group();
  const textures: Texture[] = [];
  const keep = <T extends Texture>(t: T) => (textures.push(t), t);

  const shadow = sheet(width * 1.18, height * 1.2, keep(shadowTexture()), LAYER.SHADOW);
  shadow.position.set(width * 0.015, -height * 0.035, 0);
  group.add(shadow);

  const pocket = sheet(
    width,
    height,
    keep(pocketTexture(width, height, texelsPerUnit)),
    LAYER.POCKET,
  );
  group.add(pocket);

  // The flap hangs from its hinge on the top edge. Its outer face looks at the
  // guest while it is closed; turned past upright, its liner does.
  const flap = new Group();
  flap.position.set(0, height / 2, 0.5);
  const outer = sheet(
    width,
    flapDepth,
    keep(flapTexture(width, flapDepth, texelsPerUnit, "outer")),
    LAYER.FLAP_CLOSED,
  );
  outer.position.y = -flapDepth / 2;
  outer.userData["layers"] = { closed: LAYER.FLAP_CLOSED, open: LAYER.FLAP_OPEN };
  const inner = sheet(
    width,
    flapDepth,
    keep(flapTexture(width, flapDepth, texelsPerUnit, liner)),
    LAYER.FLAP_CLOSED,
    BackSide,
  );
  inner.position.y = -flapDepth / 2;
  inner.userData["layers"] = { closed: LAYER.FLAP_CLOSED, open: LAYER.FLAP_OPEN };
  flap.add(outer, inner);
  group.add(flap);

  let isOpen = false;
  // The envelope's own sheets, once. The seal rides in `group` too, and owns
  // its materials: their opacity and their disposal are the seal's.
  const sheets = [shadow, pocket, outer, inner];
  const materials = sheets.map((mesh) => mesh.material as Material);
  let opacity = 1;

  return {
    group,
    flap,
    setFlap(angle) {
      flap.rotation.x = -angle;
      const open = angle > Math.PI / 2;
      if (open !== isOpen) {
        isOpen = open;
        layerFlap(flap, open);
      }
    },
    setOpacity(alpha) {
      if (alpha === opacity) return;
      opacity = alpha;
      for (const material of materials) material.opacity = alpha;
      group.visible = alpha > 0;
    },
    dispose() {
      for (const mesh of sheets) mesh.geometry.dispose();
      for (const material of materials) material.dispose();
      for (const t of textures) t.dispose();
    },
  };
}
