// PASE V2 — Modal
// Modal limpio: backdrop + panel centrado. Sin animaciones gratuitas.
// Tamaños: sm | md | lg | xl
// Bug fix conocido (Modal.tsx viejo): los inputs perdían foco entre
// dígitos porque onClose estaba en useEffect deps. Acá usamos solo
// [isOpen] + onCloseRef para evitar el mismo bug.

import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
}

const sizeMap: Record<string, string> = {
  sm: "420px",
  md: "560px",
  lg: "760px",
  xl: "960px",
};

export function Modal({
  isOpen, onClose, title, children, size = "md", footer, closeOnBackdrop = true,
}: ModalProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // ESC para cerrar + focus management.
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", handleEsc);

    // Auto-focus primer INPUT (NO primer focusable — sería el botón X).
    const t = setTimeout(() => {
      const firstInput = document.querySelector<HTMLInputElement>(
        ".v2-modal-content input:not([type=hidden]), .v2-modal-content textarea, .v2-modal-content select"
      );
      if (firstInput) firstInput.focus();
    }, 50);

    return () => {
      document.removeEventListener("keydown", handleEsc);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose es accedido via ref para no re-disparar el effect en cada render.
  }, [isOpen]);

  if (!isOpen) return null;

  const backdropStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.5)",
    backdropFilter: "blur(2px)",
    zIndex: 1100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--v2-space-4)",
  };

  const panelStyle: CSSProperties = {
    background: "var(--v2-bg-2)",
    border: "1px solid var(--v2-border)",
    borderRadius: "var(--v2-radius-md)",
    width: "100%",
    maxWidth: sizeMap[size],
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };

  return (
    <div
      style={backdropStyle}
      onClick={() => { if (closeOnBackdrop) onClose(); }}
    >
      <div
        style={panelStyle}
        onClick={e => e.stopPropagation()}
        className="v2-modal-content"
      >
        {title && (
          <div style={{
            padding: "var(--v2-space-4) var(--v2-space-5)",
            borderBottom: "1px solid var(--v2-border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <h2 className="v2-h2">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--v2-text-muted)",
                cursor: "pointer",
                padding: "var(--v2-space-1)",
                borderRadius: "var(--v2-radius-xs)",
                display: "inline-flex",
              }}
              aria-label="Cerrar"
            >
              <X size={18} />
            </button>
          </div>
        )}

        <div style={{
          padding: "var(--v2-space-5)",
          overflowY: "auto",
          flex: 1,
        }}>
          {children}
        </div>

        {footer && (
          <div style={{
            padding: "var(--v2-space-4) var(--v2-space-5)",
            borderTop: "1px solid var(--v2-border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--v2-space-2)",
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
