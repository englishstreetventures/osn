import { type Mock, vi } from "vitest";

export const mockToastError: Mock = vi.fn();
export const mockToastSuccess: Mock = vi.fn();

type ToastFn = Mock & { error: Mock; success: Mock };

/** Factory for `vi.mock("@shared/toast", async () => toastMock())` */
export function toastMock(): { default: ToastFn; toast: ToastFn } {
  const toastFn: ToastFn = Object.assign(vi.fn(), {
    error: mockToastError,
    success: mockToastSuccess,
  });
  return {
    default: toastFn,
    toast: toastFn, // named export used by `import { toast } from "@shared/toast"`
  };
}
