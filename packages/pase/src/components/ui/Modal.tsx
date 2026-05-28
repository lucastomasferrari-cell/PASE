import { useEffect, useRef } from "react";
import type { ReactNode, MouseEvent } from "react";
import styles from "./Modal.module.css";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Título visible en el header del modal (17px primary weight 500). */
  title: string;
  /** Subtítulo opcional debajo del título (11px muted). */
  subtitle?: string;
  /** Contenido principal del modal. */
  children: ReactNode;
  /** Footer opcional — típicamente botones Cancelar + Acción (flex 1 c/u). */
  footer?: ReactNode;
  /** Max width del dialog. Default 720px. */
  maxWidth?: number;
  /** Si true, el overlay no cierra al clickearlo (útil para forms con datos). */
  preventCloseOnOverlay?: boolean;
}

/** Modal/Dialog reusable — fade-in del overlay + scale-up del panel.
 *  Sigue el patrón visual del design system v1.0 (overlay celeste tenue,
 *  panel blanco con border 0.5px, radius 14, padding 22x24).
 *
 *  Cierra con:
 *  - Click en el overlay (a menos que preventCloseOnOverlay=true).
 *  - Click en el botón ✕.
 *  - Tecla Escape.
 */
export function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxWidth = 720,
  preventCloseOnOverlay = false,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // BUG FIX 2026-05-28 (Lucas): usar ref de onClose para que NO sea dependency
  // del effect de abajo. Cada keystroke en un input del modal disparaba
  // re-render del padre → nueva fn onClose → effect re-ejecutaba → enfocaba
  // el primer focusable (el botón ✕) → input perdía foco entre dígitos.
  // Con ref el effect solo corre cuando isOpen cambia.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    // AUDIT F4B#1 a11y: guardar el elemento que tenía focus antes de abrir
    // para restaurarlo al cerrar. Sin esto el focus queda perdido en el body.
    prevFocusRef.current = document.activeElement as HTMLElement | null;

    // Focus inicial: enfocar el primer INPUT/textarea/select del modal (más útil
    // que enfocar el botón ✕). Si no hay inputs editables, fallback al primer
    // elemento focuseable (botón) y, si tampoco hay, al dialog mismo.
    const inputSel = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';
    const focusableSel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const firstInput = dialogRef.current?.querySelector<HTMLElement>(inputSel);
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(focusableSel);
    if (firstInput) firstInput.focus();
    else if (focusables?.[0]) focusables[0].focus();
    else dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onCloseRef.current(); return; }
      // AUDIT F4B#1 a11y: focus trap. Tab desde el último → primer.
      // Shift+Tab desde el primero → último. Sin esto, Tab sale al body.
      if (e.key === "Tab" && focusables && focusables.length > 0) {
        const firstEl = focusables[0]!;
        const lastEl = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);

    // Bloquear scroll del body cuando el modal está abierto.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Restaurar focus
      try { prevFocusRef.current?.focus(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose intencionalmente via ref para evitar re-render-induced focus steal (bug 2026-05-28)
  }, [isOpen]);

  if (!isOpen) return null;

  const onOverlayClick = (e: MouseEvent<HTMLDivElement>) => {
    // Solo cierra si el click fue directamente sobre el overlay, no en hijos.
    if (e.target === e.currentTarget && !preventCloseOnOverlay) onClose();
  };

  return (
    <div className={styles.overlay} onClick={onOverlayClick} role="presentation">
      <div
        ref={dialogRef}
        className={styles.dialog}
        style={{ maxWidth }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <div>
            <div className={styles.title}>{title}</div>
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Cerrar"
            title="Cerrar"
          >
            ✕
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
