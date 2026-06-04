// Recibo de sueldo imprimible — un recibo (hoja). Layout aprobado por Lucas
// (companion visual, 04-jun). Estilos fijos pensados para impresión A4 (no
// usa variables de tema — el recibo siempre es negro sobre blanco).
import { fmt_$ } from "@pase/shared/utils";
import { fmt_d } from "../../lib/utils";
import type { ReciboSueldoModel } from "../../lib/recibos";

export function ReciboSueldo({ recibo }: { recibo: ReciboSueldoModel }) {
  const r = recibo;
  return (
    <div className="recibo-page" style={{
      width: 540, margin: "0 auto 16px", background: "#fff", color: "#1a2230",
      fontFamily: "'Segoe UI',Arial,sans-serif", fontSize: 13, lineHeight: 1.45,
      border: "1px solid #d4dae2", borderRadius: 4, overflow: "hidden",
    }}>
      {/* Encabezado negocio */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "16px 20px", borderBottom: "2px solid #1a2230" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{r.negocio.razonSocial}</div>
          <div style={{ color: "#566", fontSize: 11 }}>
            {r.negocio.cuit ? `CUIT ${r.negocio.cuit}` : ""}{r.negocio.cuit && r.negocio.direccion ? " · " : ""}{r.negocio.direccion ?? ""}
          </div>
          {r.negocio.sucursal && <div style={{ color: "#566", fontSize: 11 }}>Sucursal: {r.negocio.sucursal}</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: .5 }}>RECIBO DE SUELDO</div>
          <div style={{ color: "#566", fontSize: 11 }}>Período: <b>{r.periodo}</b></div>
          {r.modo && <div style={{ color: "#566", fontSize: 11 }}>Modo: {r.modo}</div>}
        </div>
      </div>

      {/* Datos empleado */}
      <div style={{ padding: "12px 20px", background: "#f6f8fb", fontSize: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" }}>
        <div><span style={{ color: "#889" }}>Empleado:</span> <b>{r.empleado.nombre}</b></div>
        {r.empleado.cuil && <div><span style={{ color: "#889" }}>CUIL:</span> {r.empleado.cuil}</div>}
        {r.empleado.puesto && <div><span style={{ color: "#889" }}>Puesto:</span> {r.empleado.puesto}</div>}
        {r.empleado.ingreso && <div><span style={{ color: "#889" }}>Ingreso:</span> {fmt_d(r.empleado.ingreso)}</div>}
      </div>

      {/* Desglose */}
      <div style={{ padding: "14px 20px" }}>
        <div style={{ fontSize: 10, color: "#889", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6 }}>Detalle de haberes y descuentos</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <tbody>
            {r.conceptos.map((c, i) => (
              <tr key={i} style={{ color: c.signo === "-" ? "#c0392b" : "#1a8a4a" }}>
                <td style={{ padding: "4px 0" }}>{c.signo === "-" ? "− " : "+ "}{c.label}</td>
                <td style={{ textAlign: "right" }}>{c.signo === "-" ? "− " : ""}{fmt_$(c.monto)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid #1a2230", fontWeight: 700, fontSize: 14 }}>
              <td style={{ padding: "8px 0" }}>TOTAL A COBRAR</td>
              <td style={{ textAlign: "right" }}>{fmt_$(r.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Forma de pago */}
      {r.pagos.length > 0 && (
        <div style={{ padding: "0 20px 14px" }}>
          <div style={{ fontSize: 10, color: "#889", textTransform: "uppercase", letterSpacing: .5, marginBottom: 6 }}>Forma de pago</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {r.pagos.map((p, i) => (
              <div key={i} style={{ flex: "1 1 120px", background: "#f3f6fa", border: "1px solid #dde5ee", borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ fontSize: 11, color: "#566" }}>{p.medio}</div>
                <div style={{ fontWeight: 700 }}>{fmt_$(p.monto)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Firma */}
      <div style={{ padding: "14px 20px 20px", borderTop: "1px dashed #b8c2cf", fontSize: 11.5, color: "#445" }}>
        Recibí conforme la suma de <b>{fmt_$(r.total)}</b> ({r.totalEnLetras}) en concepto de
        {r.tipo === "final" ? " liquidación final" : " sueldo"} correspondiente a <b>{r.periodo}</b>.
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 36, gap: 20 }}>
          <div style={{ flex: 1, borderTop: "1px solid #1a2230", paddingTop: 4, textAlign: "center", fontSize: 10, color: "#889" }}>Firma</div>
          <div style={{ flex: 1, borderTop: "1px solid #1a2230", paddingTop: 4, textAlign: "center", fontSize: 10, color: "#889" }}>Aclaración</div>
          <div style={{ flex: 1, borderTop: "1px solid #1a2230", paddingTop: 4, textAlign: "center", fontSize: 10, color: "#889" }}>DNI · Fecha</div>
        </div>
      </div>
    </div>
  );
}
