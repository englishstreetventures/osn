# @shared/typescript-config

Shared TypeScript base configs for the monorepo. Every workspace extends
one of these so compiler options stay consistent.

## Exports

- `@shared/typescript-config/base.json` — common baseline (strict, ESNext
  target, moduleResolution: bundler)
- `@shared/typescript-config/node.json` — adds Node/Bun-specific settings
- `@shared/typescript-config/solid.json` — adds SolidJS JSX settings

## Usage

```jsonc
// osn/core/tsconfig.json
{
  "extends": "@shared/typescript-config/node.json",
  "include": ["src/**/*", "tests/**/*"]
}
```
