import type { Toast, ToastType } from "../hooks/useToast";

const COLORS: Record<ToastType, string> = {
  success: "var(--success)",
  error: "var(--danger)",
  warn: "var(--warn)",
  info: "var(--info)",
};

export function ToastComponent({ toast }: { toast: Toast | null }) {
  if (!toast) return null;
  return (
    <div style={{
      position: "fixed", top: 16, right: 16, zIndex: 300,
      padding: "10px 20px", borderRadius: "var(--r)",
      background: COLORS[toast.type], color: "#000",
      fontSize: 12, fontWeight: 600,
      boxShadow: "0 4px 12px rgba(0,0,0,.5)",
      fontFamily: "'Inter', sans-serif",
    }}>
      {toast.message}
    </div>
  );
}
