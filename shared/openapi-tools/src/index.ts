export { generateOpenApiDocument, type GenerateOptions } from "./generate";
export {
  collapseNullUnions,
  excludePaths,
  normalizeOpenApiDocument,
  resolveBareRefs,
  sortKeys,
  stripComponentIds,
  stripRedundantNullable,
  stripVoidContent,
  type NormalizedDocument,
} from "./normalize";
