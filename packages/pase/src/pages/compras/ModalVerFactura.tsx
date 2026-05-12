import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { fmt_d, fmt_$ } from "../../lib/utils";
import type { Local } from "../../types";
import type { Proveedor, Factura, PagoFactura } from "../../types/finanzas";

interface ModalVerFacturaProps {
  factura: Factura | null;
  onClose: () => void;
  proveedores: Proveedor[];
  locales: Local[];
}

// Modal solo-lectura con el desglose de IVA, percepciones, pagos
// registrados y comprobante (imagen o PDF). Carga signed URL on-demand
// del bucket `facturas` y la resetea al cerrar.
export function ModalVerFactura({ factura, onClose, proveedores, locales }: ModalVerFacturaProps) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!factura?.imagen_url) { setImgUrl(null); return; }
    let cancelled = false;
    setImgLoading(true);
    db.storage.from("facturas").createSignedUrl(factura.imagen_url, 3600)
      .then(({ data, error }) => {
        if (cancelled) return;
        setImgLoading(false);
        if (error || !data) { setImgUrl(null); return; }
        setImgUrl(data.signedUrl);
      });
    return () => { cancelled = true; };
  }, [factura?.imagen_url]);

  if (!factura) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Factura {factura.nro}</div><button className="close-btn" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form2">
            <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Proveedor</span><div style={{ marginTop: 4 }}>{proveedores.find(p => String(p.id) === String(factura.prov_id))?.nombre}</div></div>
            <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Local</span><div style={{ marginTop: 4 }}>{locales.find(l => String(l.id) === String(factura.local_id))?.nombre}</div></div>
          </div>
          <div className="form3" style={{ marginTop: 12 }}>
            <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Fecha</span><div style={{ marginTop: 4 }}>{fmt_d(factura.fecha)}</div></div>
            <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Vencimiento</span><div style={{ marginTop: 4 }}>{fmt_d(factura.venc)}</div></div>
            <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Categoría</span><div style={{ marginTop: 4 }}>{factura.cat}</div></div>
          </div>
          <div style={{ marginTop: 16, background: "var(--s2)", padding: 12, borderRadius: "var(--r)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>Neto Gravado</span><span>{fmt_$(factura.neto)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>IVA 21%</span><span>{fmt_$(factura.iva21)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>IVA 10.5%</span><span>{fmt_$(factura.iva105)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>Perc. IIBB</span><span>{fmt_$(factura.iibb)}</span></div>
            {Number(factura.perc_iva) > 0 && <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>Perc. IVA</span><span>{fmt_$(factura.perc_iva)}</span></div>}
            {Number(factura.otros_cargos) > 0 && <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>Otros Cargos</span><span>{fmt_$(factura.otros_cargos)}</span></div>}
            {Number(factura.descuentos) > 0 && <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "var(--danger)" }}><span>Descuentos</span><span>− {fmt_$(factura.descuentos)}</span></div>}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--bd)", paddingTop: 8, fontFamily: "'Inter',sans-serif", fontSize: 16, fontWeight: 500 }}><span>TOTAL</span><span style={{ color: "var(--acc)" }}>{fmt_$(factura.total)}</span></div>
          </div>
          {(factura.pagos || []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase", marginBottom: 8 }}>Pagos registrados</div>
              {factura.pagos.map((p: PagoFactura, i: number) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--bd)", fontSize: 12 }}>
                  <span>{fmt_d(p.fecha)} · {p.cuenta}</span><span style={{ color: "var(--muted2)" }}>{fmt_$(p.monto)}</span>
                </div>
              ))}
            </div>
          )}
          {factura.imagen_url && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase", marginBottom: 8 }}>Comprobante</div>
              {imgLoading && <div className="loading">Cargando comprobante...</div>}
              {!imgLoading && imgUrl && (() => {
                const isPdf = /\.pdf$/i.test(factura.imagen_url!);
                return isPdf ? (
                  <div>
                    <iframe src={imgUrl} style={{ width: "100%", height: 500, border: "1px solid var(--bd)", borderRadius: "var(--r)", background: "#fff" }} />
                    <div style={{ marginTop: 6, fontSize: 11 }}>
                      <a href={imgUrl} target="_blank" rel="noreferrer" style={{ color: "var(--acc)" }}>Abrir en nueva pestaña →</a>
                    </div>
                  </div>
                ) : (
                  <div>
                    <a href={imgUrl} target="_blank" rel="noreferrer">
                      <img src={imgUrl} alt="Comprobante" style={{ width: "100%", maxHeight: 500, objectFit: "contain", borderRadius: "var(--r)", border: "1px solid var(--bd)", background: "#fff" }} />
                    </a>
                  </div>
                );
              })()}
              {!imgLoading && !imgUrl && (
                <div className="alert alert-warn" style={{ fontSize: 11 }}>No se pudo cargar el comprobante. El archivo puede haber sido eliminado.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
