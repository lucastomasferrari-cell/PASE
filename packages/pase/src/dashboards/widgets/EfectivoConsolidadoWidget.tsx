import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { EmptyState, ShopIcon } from "../../components/ui";
import type { WidgetContext } from "../types";

interface LocalEfectivo {
  id: number;
  nombre: string;
  efectivo: number;
}

// Efectivo consolidado (cuenta "Caja Efectivo") de TODOS los locales sumado.
// Pedido Lucas/Anto 09-jun: "necesita ver el efectivo unificado en algún lado".
//
// SOLO dueño/admin/superadmin. La razón: el SaldoCajaWidget viejo se eliminó
// (24-may) porque leakeaba Caja Efectivo a encargados. Acá el consolidado
// cross-local es info de dirección — los encargados no lo ven. Doble defensa:
//   1. guard por rol (abajo),
//   2. RLS de saldos_caja igual scopea a los locales visibles del usuario.
export function EfectivoConsolidadoWidget({ ctx }: { ctx: WidgetContext }) {
  const [rows, setRows] = useState<LocalEfectivo[]>([]);
  const [loading, setLoading] = useState(true);

  const esDireccion = ctx.usuario.rol === "dueno" || ctx.usuario.rol === "admin" || ctx.usuario.rol === "superadmin";

  useEffect(() => {
    if (!esDireccion) { setLoading(false); return; }
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const [saldosRes, localesRes] = await Promise.all([
        // eslint-disable-next-line pase-local/require-apply-local-scope -- widget CONSOLIDADO: suma Caja Efectivo de TODOS los locales del tenant a propósito. RLS sigue scopeando al tenant/locales visibles.
        db.from("saldos_caja").select("local_id, saldo").eq("cuenta", "Caja Efectivo"),
        db.from("locales").select("id, nombre").order("nombre"),
      ]);
      if (cancelled) return;
      if (saldosRes.error || localesRes.error) { setLoading(false); return; }

      const locales = (localesRes.data ?? []) as Array<{ id: number; nombre: string }>;
      const porLocal = new Map<number, number>();
      for (const r of saldosRes.data ?? []) {
        const row = r as { local_id: number; saldo: number };
        porLocal.set(row.local_id, (porLocal.get(row.local_id) ?? 0) + Number(row.saldo ?? 0));
      }
      const mapped: LocalEfectivo[] = locales
        .filter(l => porLocal.has(l.id))
        .map(l => ({ id: l.id, nombre: l.nombre, efectivo: porLocal.get(l.id) ?? 0 }))
        .sort((a, b) => b.efectivo - a.efectivo);
      setRows(mapped);
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo, esDireccion]);

  if (!esDireccion) {
    return (
      <EmptyState
        icon={<ShopIcon size={32} tone="muted" />}
        title="Solo dirección"
        description="El efectivo consolidado de todos los locales lo ve el dueño / admin."
        size="compact"
      />
    );
  }

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ShopIcon size={32} tone="muted" />}
        title="Sin efectivo cargado"
        description="No hay saldo de Caja Efectivo en ningún local todavía."
        size="compact"
      />
    );
  }

  const total = rows.reduce((s, l) => s + l.efectivo, 0);

  return (
    <div>
      <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 4 }}>
        Efectivo total · todos los locales
      </div>
      <div style={{ fontSize: "26px", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: total < 0 ? "var(--pase-danger, #DC2626)" : "var(--pase-text)", marginBottom: 12 }}>
        {formatCurrency(total)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map(l => (
          <div key={l.id} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, fontSize: "var(--pase-fs-sm)" }}>
            <span style={{ color: "var(--pase-text-muted)" }}>{l.nombre}</span>
            <strong style={{ fontVariantNumeric: "tabular-nums", color: l.efectivo < 0 ? "var(--pase-danger, #DC2626)" : "var(--pase-text)" }}>
              {formatCurrency(l.efectivo)}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}
