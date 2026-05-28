import { fmt_d, fmt_$ } from "../../lib/utils";
import type { Factura } from "../../types/finanzas";
import type { Remito } from "./types";
import { Modal } from "../../components/ui";

interface ModalVincularRemitoProps {
  remito: Remito | null;
  onClose: () => void;
  facturas: Factura[];
  onVincular: (factura_id: string) => void;
}

// Modal para vincular un remito provisorio a una factura del mismo
// proveedor. La deuda provisoria del remito se ajusta con la deuda
// fiscal de la factura — la diferencia queda registrada.
export function ModalVincularRemito({ remito, onClose, facturas, onVincular }: ModalVincularRemitoProps) {
  if (!remito) return null;
  const candidatas = facturas.filter(f => String(f.prov_id) === String(remito.prov_id) && f.estado === "pendiente");
  /* AUDIT F4B#1 / sprint #5: migrado a <Modal>. */
  return (
    <Modal
      isOpen={!!remito}
      onClose={onClose}
      title="Vincular a Factura"
    >
      <div className="alert alert-warn">Remito {remito.nro} · {fmt_$(remito.monto)}</div>
      <p style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 12 }}>Al vincular, la deuda provisoria del remito se ajusta con la deuda fiscal de la factura.</p>
      <table>
        <thead><tr><th>Factura</th><th>Fecha</th><th>Total</th><th>Diferencia</th><th></th></tr></thead>
        <tbody>{candidatas.map(f => {
          const diff = (f.total || 0) - (remito.monto || 0);
          return (
            <tr key={f.id}>
              <td className="mono">{f.nro}</td>
              <td>{fmt_d(f.fecha)}</td>
              <td className="num">{fmt_$(f.total)}</td>
              <td style={{ color: diff > 0 ? "var(--danger)" : diff < 0 ? "var(--success)" : "var(--muted2)" }}>{diff > 0 ? "+" : ""}{fmt_$(diff)}</td>
              <td><button className="btn btn-acc btn-sm" onClick={() => onVincular(f.id)}>Vincular</button></td>
            </tr>
          );
        })}</tbody>
      </table>
      {candidatas.length === 0 && <div className="empty">No hay facturas pendientes de este proveedor</div>}
    </Modal>
  );
}
