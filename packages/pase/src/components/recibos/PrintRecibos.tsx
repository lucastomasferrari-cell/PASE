// Vista de impresión de recibos (Lucas 04-jun). Overlay full-screen con una
// barra (Imprimir / Cerrar) + 1..N recibos. El @media print oculta todo menos
// los recibos y mete un salto de página entre cada uno (un recibo por hoja).
import { useEffect } from "react";
import { ReciboSueldo } from "./ReciboSueldo";
import type { ReciboSueldoModel } from "../../lib/recibos";

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .recibo-print-root, .recibo-print-root * { visibility: visible !important; }
  .recibo-print-root {
    position: absolute !important; left: 0; top: 0; width: 100%;
    padding: 0 !important; background: #fff !important; overflow: visible !important;
  }
  .recibo-no-print { display: none !important; }
  .recibo-page {
    page-break-after: always; border: none !important; box-shadow: none !important;
    margin: 0 auto !important;
  }
  .recibo-page:last-child { page-break-after: auto; }
}
`;

export function PrintRecibos({ recibos, onClose }: { recibos: ReciboSueldoModel[]; onClose: () => void }) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9000, background: "rgba(15,20,30,0.55)",
      overflow: "auto", padding: "0 0 40px",
    }}>
      <style>{PRINT_CSS}</style>

      {/* Barra de acciones (no se imprime) */}
      <div className="recibo-no-print" style={{
        position: "sticky", top: 0, zIndex: 1, display: "flex", justifyContent: "center",
        gap: 10, padding: "12px", background: "var(--s2, #16202e)", borderBottom: "1px solid var(--bd,#26344a)",
      }}>
        <span style={{ alignSelf: "center", color: "var(--muted2,#9fb0c4)", fontSize: 12, marginRight: 8 }}>
          {recibos.length} recibo{recibos.length !== 1 ? "s" : ""}
        </span>
        <button className="btn btn-acc" onClick={() => window.print()}>🖨 Imprimir</button>
        <button className="btn btn-sec" onClick={onClose}>Cerrar</button>
      </div>

      {/* Recibos */}
      <div className="recibo-print-root" style={{ padding: "20px 0" }}>
        {recibos.map((r, i) => <ReciboSueldo key={i} recibo={r} />)}
      </div>
    </div>
  );
}
