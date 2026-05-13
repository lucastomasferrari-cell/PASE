import type { Toast } from "../hooks/useToast";

// Calm design v1.0: el toast es un mensaje sutil arriba a la derecha sin
// colores de alerta ni shadow profunda. La tipología (success/error/warn/info)
// no se distingue visualmente — el texto del mensaje comunica la naturaleza.
export function ToastComponent({ toast }: { toast: Toast | null }) {
  if (!toast) return null;
  return (
    <div style={{
      position: "fixed", top: 16, right: 16, zIndex: 300,
      padding: "10px 16px",
      borderRadius: 14,
      background: "var(--pase-bg)",
      color: "var(--pase-text)",
      border: "0.5px solid var(--pase-celeste-300)",
      fontSize: 12, fontWeight: 500,
      fontFamily: "var(--pase-font)",
      letterSpacing: "-0.005em",
    }}>
      {toast.message}
    </div>
  );
}
