import { useState, useCallback } from "react";

export type ToastType = "success" | "error" | "warn" | "info";

export interface Toast {
  message: string;
  type: ToastType;
}

export function useToast(duration = 3000) {
  const [toast, setToast] = useState<Toast | null>(null);

  const showToast = useCallback((message: string, type: ToastType = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), duration);
  }, [duration]);

  const showError = useCallback((message: string) => showToast(message, "error"), [showToast]);
  const showWarn = useCallback((message: string) => showToast(message, "warn"), [showToast]);
  const showInfo = useCallback((message: string) => showToast(message, "info"), [showToast]);

  return { toast, showToast, showError, showWarn, showInfo };
}
