// Vista de impresión de recibos (Lucas 04-jun). Overlay full-screen con una
// barra (Imprimir / Cerrar) + 1..N recibos.
//
// FIX 01-jul (Anto: "el PDF de recibos de Devoto salió con solo 2 empleados"):
// el approach viejo ponía el overlay en `position:fixed; inset:0; overflow:auto`
// y los recibos en `position:absolute` dentro. Al imprimir, ese contenedor de
// alto fijo con overflow RECORTABA el contenido a lo que entraba en pantalla
// (~2 recibos) y Chrome descartaba el resto → el PDF salía truncado. Patrón de
// impresión roto conocido.
//
// Ahora: el overlay se monta en un PORTAL como hijo directo de <body>. En
// impresión ocultamos TODO menos ese portal (así no arrastra la altura de la
// app oculta) y lo pasamos a flujo normal (position:static, sin overflow, alto
// automático) → el navegador pagina los N recibos completos, uno por hoja.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ReciboSueldo } from "./ReciboSueldo";
import type { ReciboSueldoModel } from "../../lib/recibos";

const PRINT_CSS = `
@media print {
  /* Ocultar toda la app (y cualquier otro nodo de body) menos el portal de
     recibos. Sin esto, el #root oculto seguía ocupando alto y metía hojas en
     blanco / desplazaba los recibos. */
  body > *:not(.recibo-print-portal) { display: none !important; }
  .recibo-print-portal {
    position: static !important; inset: auto !important;
    overflow: visible !important; height: auto !important;
    background: #fff !important; padding: 0 !important;
  }
  .recibo-print-root { padding: 0 !important; }
  .recibo-no-print { display: none !important; }
  .recibo-page {
    page-break-after: always; break-after: page;
    border: none !important; box-shadow: none !important; margin: 0 auto !important;
  }
  .recibo-page:last-child { page-break-after: auto; break-after: auto; }
}
`;

export function PrintRecibos({ recibos, onClose }: { recibos: ReciboSueldoModel[]; onClose: () => void }) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return createPortal(
    <div className="recibo-print-portal" style={{
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
    </div>,
    document.body,
  );
}
