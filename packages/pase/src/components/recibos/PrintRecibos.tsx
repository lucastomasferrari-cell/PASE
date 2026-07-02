// Vista de impresión de recibos. Portal directo en <body>; en print se oculta
// todo menos el portal y se pagina 2 recibos por hoja A4 con línea de corte.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ReciboSueldo } from "./ReciboSueldo";
import type { ReciboSueldoModel } from "../../lib/recibos";

const PRINT_CSS = `
@media print {
  body > *:not(.recibo-print-portal) { display: none !important; }
  .recibo-print-portal {
    position: static !important; inset: auto !important;
    overflow: visible !important; height: auto !important;
    background: #fff !important; padding: 0 !important;
  }
  .recibo-print-root { padding: 0 !important; }
  .recibo-no-print { display: none !important; }
  .recibo-pair {
    page-break-after: always; break-after: page;
    display: flex; flex-direction: column;
    justify-content: flex-start;
    height: 100vh;
    box-sizing: border-box;
  }
  .recibo-pair:last-child { page-break-after: auto; break-after: auto; }
  .recibo-page {
    border: none !important; box-shadow: none !important;
    margin: 0 auto !important; width: 100% !important;
    max-width: 540px !important;
  }
  .recibo-cut-line {
    border-top: 1px dashed #999 !important;
    margin: 6px 40px !important;
    position: relative;
  }
  .recibo-cut-line::after {
    content: "✂";
    position: absolute; top: -9px; left: -20px;
    font-size: 14px; color: #999;
  }
  .recibo-page { font-size: 11px !important; }
  .recibo-page .recibo-header { padding: 10px 16px !important; }
  .recibo-page .recibo-employee { padding: 8px 16px !important; }
  .recibo-page .recibo-detail { padding: 8px 16px !important; }
  .recibo-page .recibo-payments { padding: 0 16px 8px !important; }
  .recibo-page .recibo-signature { padding: 8px 16px 12px !important; }
  .recibo-page .recibo-sig-lines { margin-top: 18px !important; }
}
`;

function groupPairs(recibos: ReciboSueldoModel[]): ReciboSueldoModel[][] {
  const pairs: ReciboSueldoModel[][] = [];
  for (let i = 0; i < recibos.length; i += 2) {
    pairs.push(recibos.slice(i, i + 2));
  }
  return pairs;
}

export function PrintRecibos({ recibos, onClose }: { recibos: ReciboSueldoModel[]; onClose: () => void }) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const pairs = groupPairs(recibos);
  const hojas = pairs.length;

  return createPortal(
    <div className="recibo-print-portal" style={{
      position: "fixed", inset: 0, zIndex: 9000, background: "rgba(15,20,30,0.55)",
      overflow: "auto", padding: "0 0 40px",
    }}>
      <style>{PRINT_CSS}</style>

      <div className="recibo-no-print" style={{
        position: "sticky", top: 0, zIndex: 1, display: "flex", justifyContent: "center",
        gap: 10, padding: "12px", background: "var(--s2, #16202e)", borderBottom: "1px solid var(--bd,#26344a)",
      }}>
        <span style={{ alignSelf: "center", color: "var(--muted2,#9fb0c4)", fontSize: 12, marginRight: 8 }}>
          {recibos.length} recibo{recibos.length !== 1 ? "s" : ""} · {hojas} hoja{hojas !== 1 ? "s" : ""}
        </span>
        <button className="btn btn-acc" onClick={() => window.print()}>🖨 Imprimir</button>
        <button className="btn btn-sec" onClick={onClose}>Cerrar</button>
      </div>

      <div className="recibo-print-root" style={{ padding: "20px 0" }}>
        {pairs.map((pair, pi) => (
          <div className="recibo-pair" key={pi}>
            <ReciboSueldo recibo={pair[0]!} />
            {pair.length === 2 && (
              <>
                <div className="recibo-cut-line" style={{
                  borderTop: "1px dashed #ccc", margin: "8px 60px",
                }} />
                <ReciboSueldo recibo={pair[1]!} />
              </>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
