import { lazy, Suspense } from "react";
import type { Usuario, Local } from "../../types";

// Lazy: LectorFacturasIA (~550 LOC) solo se carga cuando se abre el modal.
// La mayoría de las veces que el user entra a Compras, NO usa lector IA
// (carga manual con +Cargar factura). Sin esto el chunk de Compras incluye
// 550 LOC de parsing/preview que solo aplica a un flujo opcional.
const LectorFacturasIA = lazy(() => import("../LectorFacturasIA"));

interface ModalLectorIAProps {
  abierto: boolean;
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
  onClose: () => void;
  onSaved: () => void;
}

// Wrapper de modal sobre LectorFacturasIA. Cierra solo con X o ESC,
// no con click en backdrop (para no perder la factura subida).
export function ModalLectorIA({ abierto, user, locales, localActivo, onClose, onSaved }: ModalLectorIAProps) {
  if (!abierto) return null;
  return (
    <div className="overlay">
      <div className="modal" style={{ width: 720 }}>
        <div className="modal-hd">
          <div className="modal-title">Lector Facturas IA</div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <Suspense fallback={<div style={{padding:24,color:"var(--muted)"}}>Cargando lector IA…</div>}>
            <LectorFacturasIA user={user} locales={locales} localActivo={localActivo} onSaved={onSaved} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
