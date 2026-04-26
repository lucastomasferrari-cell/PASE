import { useState } from "react";

// Modal bloqueante para encargados con >1 local asignado al inicio de
// sesión. Forza a elegir con qué local van a operar — evita que queden con
// localActivo=null y terminen viendo data de todos sus locales mezclada
// (leak causa del bug #27). Sin cerrar, sin X, sin escape: la única salida
// es confirmar un local.
export default function SeleccionarLocalModal({
  user, locales, onConfirm,
}: { user: any; locales: any[]; onConfirm: (localId: number) => void }) {
  const [selected, setSelected] = useState<string>("");
  const localesDisp = (locales || []).filter((l: any) =>
    (user?._locales || user?.locales || []).includes(l.id),
  );

  return (
    <div className="login-wrap">
      <div className="login-bg" />
      <div className="login-card" style={{ maxWidth: 420 }}>
        <div className="login-brand" style={{ fontSize: 15 }}>Elegí el local</div>
        <div className="login-sub" style={{ marginBottom: 14 }}>
          Con qué local querés trabajar en esta sesión
        </div>
        <div className="alert alert-info" style={{ fontSize: 11, marginBottom: 12 }}>
          Tu usuario tiene {localesDisp.length} locales asignados. Elegí uno para operar. Después podés cambiar desde el sidebar.
        </div>
        <div className="field">
          <label>Local</label>
          <select value={selected} onChange={e => setSelected(e.target.value)}>
            <option value="">Seleccioná...</option>
            {localesDisp.map((l: any) => (
              <option key={l.id} value={l.id}>{l.nombre}</option>
            ))}
          </select>
        </div>
        <button
          className="btn btn-acc"
          style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
          disabled={!selected}
          onClick={() => onConfirm(parseInt(selected))}
        >Confirmar</button>
      </div>
    </div>
  );
}
