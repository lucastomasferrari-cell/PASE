import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { EmptyState } from "../../components/ui";
import type { WidgetContext } from "../types";

interface Saldo {
  cuenta: string;
  saldo: number;
}

// Saldos de caja del local activo (o consolidado si dueño/admin sin local).
export function SaldoCajaWidget({ ctx }: { ctx: WidgetContext }) {
  const [saldos, setSaldos] = useState<Saldo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      let q = db.from("saldos_caja").select("cuenta, saldo");
      if (ctx.localActivo !== null) q = q.eq("local_id", ctx.localActivo);
      const { data, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const map = new Map<string, number>();
      for (const r of data ?? []) {
        const cuenta = (r as { cuenta: string }).cuenta;
        const saldo = Number((r as { saldo: number | string }).saldo ?? 0);
        map.set(cuenta, (map.get(cuenta) ?? 0) + saldo);
      }
      setSaldos(Array.from(map.entries()).map(([cuenta, saldo]) => ({ cuenta, saldo })));
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (saldos.length === 0) {
    return (
      <EmptyState
        icon="💰"
        title="Sin saldos en caja"
        description="Cuando se carguen movimientos vas a ver los saldos acá."
        size="compact"
      />
    );
  }

  return (
    <div>
      {saldos.map((s, idx) => (
        <div
          key={s.cuenta}
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            padding: "8px 0",
            borderBottom: idx < saldos.length - 1 ? "0.5px solid var(--pase-border)" : "none",
            fontSize: "var(--pase-fs-base)",
          }}
        >
          <span style={{ color: "var(--pase-text-muted)" }}>{s.cuenta}</span>
          <strong style={{ fontVariantNumeric: "tabular-nums" }}>{formatCurrency(s.saldo)}</strong>
        </div>
      ))}
    </div>
  );
}
