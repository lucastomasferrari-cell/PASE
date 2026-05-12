import LectorFacturasIA from "../LectorFacturasIA";
import type { Usuario, Local } from "../../types";

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
          <LectorFacturasIA user={user} locales={locales} localActivo={localActivo} onSaved={onSaved} />
        </div>
      </div>
    </div>
  );
}
