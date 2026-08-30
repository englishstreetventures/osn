---
---

Stop `vite-plugin-solid` injecting `@testing-library/jest-dom/vitest` into every Vitest project's setup files; matcher-using tests import it themselves, and a shared marker file suppresses the plugin's default.
