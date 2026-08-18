// Registers the jest-dom matchers (`toHaveAttribute`, `toBeVisible`, …) and
// their types. The dependency was already installed and the matchers already
// worked at runtime; without this import TypeScript never saw them.
import "@testing-library/jest-dom/vitest";
