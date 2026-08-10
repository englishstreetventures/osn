import { vi } from "vitest";

export const mockToastError = vi.fn();
export const mockToastSuccess = vi.fn();

/** Factory for `vi.mock("solid-toast", async () => solidToastMock())` */
export function solidToastMock() {
  const toastFn = Object.assign(vi.fn(), {
    error: mockToastError,
    success: mockToastSuccess,
  });
  return {
    default: toastFn,
    toast: toastFn, // named export used by `import { toast } from "solid-toast"`
  };
}
