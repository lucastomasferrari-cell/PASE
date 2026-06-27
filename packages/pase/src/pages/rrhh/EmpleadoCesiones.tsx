// EmpleadoCesiones — gestión de los locales asignados a un empleado.
//
// Feature 2 (Lucas 2026-05-20): un empleado puede trabajar en varios locales
// además del principal. El admin de Villa Crespo trabaja también para
// Belgrano y Devoto. Esta UI permite agregar/quitar locales adicionales.
//
// Backend: tabla rrhh_empleado_locales + RPCs fn_ceder_empleado_a_local y
// fn_revocar_cesion_empleado.

import { useCallback, useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { translateRpcError } from "../../lib/errors";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";
import type { Local } from "../../types/auth";

interface CesionRow {
  id: number;
  local_id: number;
  es_principal: boolean;
  tipo: string;
  fecha_desde: string;
  fecha_hasta: string | null;
  notas: string | null;
}

interface Props {
  empleadoId: string;
  localPrincipalId: number;
  locales: Local[];
  onChange?: () => void;
}

export function EmpleadoCesiones({ empleadoId, localPrincipalId: _localPrincipalId, locales, onChange }: Props) {
  const [cesiones, setCesiones] = useState<CesionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [agregando, setAgregando] = useState(false);
  const [nuevaLocalId, setNuevaLocalId] = useState<string>("");
  const [nuevoTipo, setNuevoTipo] = useState<string>("cesion_permanente");
  const { toast, showError } = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS filtra
    const { data, error } = await db
      .from("rrhh_empleado_locales")
      .select("id, local_id, es_principal, tipo, fecha_desde, fecha_hasta, notas")
      .eq("empleado_id", empleadoId)
      .is("deleted_at", null)
      .order("es_principal", { ascending: false })
      .order("fecha_desde", { ascending: true });
    if (!error) setCesiones((data ?? []) as CesionRow[]);
    setLoading(false);
  }, [empleadoId]);

  useEffect(() => { void reload(); }, [reload]);

  async function handleAgregar() {
    if (!nuevaLocalId) return;
    const { error } = await db.rpc("fn_ceder_empleado_a_local", {
      p_empleado_id: empleadoId,
      p_local_destino_id: parseInt(nuevaLocalId),
      p_tipo: nuevoTipo,
      p_fecha_desde: null,
      p_fecha_hasta: null,
      p_notas: null,
    });
    if (error) { showError(translateRpcError(error)); return; }
    setAgregando(false);
    setNuevaLocalId("");
    await reload();
    onChange?.();
  }

  async function handleRevocar(localId: number) {
    if (!confirm("¿Revocar esta cesión? El empleado dejará de aparecer en ese local.")) return;
    const { error } = await db.rpc("fn_revocar_cesion_empleado", {
      p_empleado_id: empleadoId,
      p_local_id: localId,
    });
    if (error) { showError(translateRpcError(error)); return; }
    await reload();
    onChange?.();
  }

  if (loading) return null;

  const localesYaAsignados = new Set(cesiones.map((c) => c.local_id));
  const localesDisponibles = locales.filter((l) => !localesYaAsignados.has(l.id));

  return (
    <div style={{
      border: "0.5px solid var(--bd)",
      borderRadius: "var(--r)",
      padding: 12,
      marginTop: 12,
      background: "var(--s2)",
    }}>
      <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "none", color: "var(--muted)", marginBottom: 8 }}>
        Locales asignados
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {cesiones.map((c) => {
          const local = locales.find((l) => l.id === c.local_id);
          const nombre = local?.nombre ?? `Local ${c.local_id}`;
          const isPrincipal = c.es_principal;
          return (
            <div
              key={c.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: isPrincipal ? "var(--pase-celeste)" : "var(--s)",
                color: isPrincipal ? "white" : "var(--text)",
                padding: "4px 10px",
                borderRadius: 14,
                fontSize: 12,
                fontWeight: 500,
              }}
              title={
                isPrincipal
                  ? "Local principal (no se puede revocar)"
                  : `Cesión ${c.tipo} desde ${c.fecha_desde}${c.fecha_hasta ? ' hasta ' + c.fecha_hasta : ''}`
              }
            >
              {isPrincipal ? "★" : "◆"} {nombre}
              {!isPrincipal && (
                <button
                  onClick={() => handleRevocar(c.local_id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                  title="Revocar cesión"
                >×</button>
              )}
            </div>
          );
        })}

        {/* Agregar nuevo */}
        {!agregando && localesDisponibles.length > 0 && (
          <button
            onClick={() => setAgregando(true)}
            className="btn btn-sec"
            style={{ fontSize: 11, padding: "4px 10px" }}
          >
            + Asignar a otro local
          </button>
        )}
      </div>

      {agregando && (
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={nuevaLocalId}
            onChange={(e) => setNuevaLocalId(e.target.value)}
            style={{ fontSize: 12, padding: "4px 8px" }}
          >
            <option value="">Local...</option>
            {localesDisponibles.map((l) => (
              <option key={l.id} value={String(l.id)}>{l.nombre}</option>
            ))}
          </select>
          <select
            value={nuevoTipo}
            onChange={(e) => setNuevoTipo(e.target.value)}
            style={{ fontSize: 12, padding: "4px 8px" }}
          >
            <option value="cesion_permanente">Cesión permanente</option>
            <option value="cesion_temporal">Cesión temporal</option>
            <option value="asignado">Asignado (igual jerarquía)</option>
          </select>
          <button className="btn btn-acc" style={{ fontSize: 11, padding: "4px 12px" }} onClick={handleAgregar} disabled={!nuevaLocalId}>
            Guardar
          </button>
          <button className="btn btn-sec" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => { setAgregando(false); setNuevaLocalId(""); }}>
            Cancelar
          </button>
        </div>
      )}

      <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 8, lineHeight: 1.4 }}>
        ★ = local principal · ◆ = cesión. Si trabaja para varios locales, los encargados de cada uno lo verán en su lista.
      </div>
      {toast && <ToastComponent toast={toast} />}
    </div>
  );
}
