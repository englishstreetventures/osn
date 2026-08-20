/**
 * Shared `(minLat, maxLat, minLng, maxLng)` viewport contract for the
 * map surfaces (`GET /venues`, `GET /events`). Cross-field checks
 * (all-four-or-none, ordering, antimeridian) can't be expressed as
 * declarative route schema constraints, so both routes call this at
 * the handler level and 400 on failure.
 */
export interface BboxCorners {
  minLat?: number;
  maxLat?: number;
  minLng?: number;
  maxLng?: number;
}

export interface Bbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export type BboxValidation = { ok: true; bbox: Bbox | null } | { ok: false; error: string };

export const validateBbox = (corners: BboxCorners): BboxValidation => {
  const { minLat, maxLat, minLng, maxLng } = corners;
  const provided = [minLat, maxLat, minLng, maxLng].filter((v) => v !== undefined);

  if (provided.length === 0) return { ok: true, bbox: null };
  if (provided.length !== 4) {
    return {
      ok: false,
      error: "minLat, maxLat, minLng, and maxLng must all be provided together, or all omitted",
    };
  }

  if (minLat! < -90 || minLat! > 90 || maxLat! < -90 || maxLat! > 90) {
    return { ok: false, error: "minLat and maxLat must be between -90 and 90" };
  }
  if (minLng! < -180 || minLng! > 180 || maxLng! < -180 || maxLng! > 180) {
    return { ok: false, error: "minLng and maxLng must be between -180 and 180" };
  }
  if (minLat! > maxLat!) {
    return { ok: false, error: "minLat must not be greater than maxLat" };
  }
  // Antimeridian-crossing boxes (minLng > maxLng) are out of scope —
  // rejected the same as any other inverted box.
  if (minLng! > maxLng!) {
    return {
      ok: false,
      error:
        "minLng must not be greater than maxLng (antimeridian-crossing boxes are not supported)",
    };
  }

  return { ok: true, bbox: { minLat: minLat!, maxLat: maxLat!, minLng: minLng!, maxLng: maxLng! } };
};
