import { Schema } from "effect";

/** A co-host's assignable role — mirrors `HostRole` in `services/hosts.ts`.
 *  `owner` is not assignable (the owner is never rowed into `wedding_hosts`)
 *  and the legacy `host` value is not accepted from clients. */
export const HostRoleSchema = Schema.Literal("editor", "viewer");
export type HostRoleSchema = Schema.Schema.Type<typeof HostRoleSchema>;

/**
 * Body for `POST /api/organiser/weddings/:weddingId/hosts`. The wedding comes
 * from the route + ownership gate; the inputs are the OSN handle to add as a
 * co-host and the role to grant. osn-api owns handle normalisation (strips `@`,
 * lowercases), so this just trims and bounds the length — a handle is ≤30
 * chars, plus a possible `@`, so 64 is a generous ceiling that caps the query
 * param. `role` defaults to `editor` — the pre-roles behaviour every existing
 * co-host had (full module writes) — so older portal builds that don't send it
 * keep working unchanged.
 */
export const AddHostBody = Schema.Struct({
  handle: Schema.String.pipe(
    Schema.transform(Schema.String, {
      strict: true,
      decode: (s) => s.trim(),
      encode: (s) => s,
    }),
    Schema.minLength(1),
    Schema.maxLength(64),
  ),
  role: Schema.optionalWith(HostRoleSchema, { default: () => "editor" as const }),
});
export type AddHostBody = Schema.Schema.Type<typeof AddHostBody>;

/** Body for `PUT /api/organiser/weddings/:weddingId/hosts/:osnProfileId/role`. */
export const UpdateHostRoleBody = Schema.Struct({
  role: HostRoleSchema,
});
export type UpdateHostRoleBody = Schema.Schema.Type<typeof UpdateHostRoleBody>;
