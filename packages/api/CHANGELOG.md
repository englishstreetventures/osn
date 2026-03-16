# @osn/api

## 0.2.1

### Patch Changes

- 7d3f9dd: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

## 0.2.0

### Minor Changes

- 880e762: Split `packages/db` into `packages/osn-db` (`@osn/db`) and `packages/pulse-db` (`@pulse/db`). Each app now owns its database layer: OSN Core owns user/session/passkey schema, Pulse owns events schema. Replace Valibot with Effect Schema in the events service — `effect/Schema` is used for service-layer domain validation and transforms (e.g. ISO string → Date), while Elysia TypeBox remains at the HTTP boundary for route validation and Eden type inference.

### Patch Changes

- Updated dependencies [880e762]
- Updated dependencies [880e762]
  - @pulse/db@0.2.0

## 0.1.1

### Patch Changes

- 51abbcc: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.
- Updated dependencies [51abbcc]
  - @osn/db@0.1.1

## 0.1.0

### Minor Changes

- efcf464: Apply auto transition for event lifecycle
- 96c406d: Added testing framework

### Patch Changes

- Updated dependencies [96c406d]
  - @osn/db@0.1.0
