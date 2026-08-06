// Vitest 4 ships the jest-dom matchers (`toBeInTheDocument`, `toHaveClass`,
// `toHaveAttribute`, …) in its own `expect`, so the tests call them without a
// setup file. It does not ship their *types*, so `astro check` saw 135
// "property does not exist on type Assertion" errors across the test tier.
// `@testing-library/jest-dom` carries the matching declarations and nothing
// else here loads them — this is a types-only import, no runtime effect.
import "@testing-library/jest-dom/vitest";
