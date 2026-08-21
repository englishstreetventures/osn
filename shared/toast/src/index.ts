import type { JSX } from "solid-js";

import { dismiss, remove, upsert } from "./store";
import type { ToastOptions, ToastTone } from "./types";

export { EXIT_MS, resetToasts, toasts } from "./store";
export { Toaster } from "./Toaster";
export type { Toast, ToastOptions, ToastPosition, ToastTone, ToasterProps } from "./types";

type Message = JSX.Element;

function raise(tone: ToastTone, message: Message, options?: ToastOptions): string {
  return upsert({ ...options, tone, message });
}

interface PromiseMessages<T> {
  loading: Message;
  success: Message | ((value: T) => Message);
  error: Message | ((error: unknown) => Message);
}

function resolveMessage<A>(message: Message | ((arg: A) => Message), arg: A): Message {
  return typeof message === "function" ? (message as (a: A) => Message)(arg) : message;
}

/**
 * Raise a toast.
 *
 * `toast(message)` is the neutral tone; the tone helpers are what the apps
 * actually call. Every form takes the same optional `ToastOptions`, so a call
 * site that starts as `toast.success("Saved")` can grow a duration or an
 * action without changing shape.
 */
function toast(message: Message, options?: ToastOptions): string {
  return raise("info", message, options);
}

toast.success = (message: Message, options?: ToastOptions) => raise("success", message, options);
toast.error = (message: Message, options?: ToastOptions) => raise("error", message, options);
toast.info = (message: Message, options?: ToastOptions) => raise("info", message, options);
toast.warning = (message: Message, options?: ToastOptions) => raise("warning", message, options);

/**
 * A toast that stays until something dismisses it. `Infinity` rather than a
 * long duration: a spinner that times out on its own leaves the user believing
 * the work finished.
 */
toast.loading = (message: Message, options?: ToastOptions) =>
  raise("loading", message, { duration: Number.POSITIVE_INFINITY, ...options });

toast.dismiss = (id?: string) => dismiss(id);
/** Drop a toast with no exit animation. Rarely what you want — prefer `dismiss`. */
toast.remove = (id: string) => remove(id);

/**
 * Bind a toast to a promise: one toast that starts as a spinner and becomes
 * the outcome in place, because `id` stays the same across all three states.
 *
 * Re-throws on rejection. The toast is a report on the promise, not a handler
 * for it — swallowing here would silently turn a failed save into a caller
 * that thinks it succeeded.
 */
toast.promise = async <T>(
  promise: Promise<T>,
  messages: PromiseMessages<T>,
  options?: ToastOptions,
): Promise<T> => {
  const id = toast.loading(messages.loading, options);
  try {
    const value = await promise;
    raise("success", resolveMessage(messages.success, value), { ...options, id });
    return value;
  } catch (error) {
    raise("error", resolveMessage(messages.error, error), { ...options, id });
    throw error;
  }
};

export { toast };
export default toast;
