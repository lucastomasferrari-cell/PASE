import type { Toast } from "../hooks/useToast";

// Calm design v1.0: el toast es un mensaje sutil arriba a la derecha sin
// colores de alerta ni shadow profunda. La tipología (success/error/warn/info)
// no se distingue visualmente — el texto del mensaje comunica la naturaleza.
//
// onDismiss opcional: si está presente, el toast es dismissible con click
// (cursor:pointer + onClick). Útil para mensajes largos de error.
export function ToastComponent({ toast, onDismiss }: { toast: Toast | null; onDismiss?: () => void }) {
  if (!toast) return null;
  return (
    <div
      onClick={onDismiss}
      style={{
        position: "fixed", top: 16, right: 16, zIndex: 300,
        padding: "10px 16px",
        borderRadius: 14,
        background: "var(--pase-bg)",
        color: "var(--pase-text)",
        border: "0.5px solid var(--pase-celeste-300)",
        fontSize: 12, fontWeight: 500,
        fontFamily: "var(--pase-font)",
        letterSpacing: "-0.005em",
        maxWidth: 420,
        cursor: onDismiss ? "pointer" : "default",
      }}
    >
      {toast.message}
    </div>
  );
}
