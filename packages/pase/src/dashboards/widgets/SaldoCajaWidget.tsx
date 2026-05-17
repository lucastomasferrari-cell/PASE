import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import type { WidgetContext } from "../types";

interface Saldo {
  cuenta: string;
  saldo: number;
}

// Saldos de caja del local activo (o consolidado si es dueño/admin sin local activo).
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
      // Agrupar por cuenta si consolidado (sumar de varios locales)
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
    return <div className="py-4 text-center text-xs text-pase-text-muted">Cargando…</div>;
  }

  if (saldos.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-pase-text-muted italic">
        Sin saldos en caja todavía.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {saldos.map(s => (
        <div
          key={s.cuenta}
          className="flex items-baseline justify-between py-1.5 border-b border-pase-border last:border-b-0"
          style={{ fontSize: "var(--pase-fs-base)" }}
        >
          <span style={{ color: "var(--pase-text-muted)" }}>{s.cuenta}</span>
          <strong className="tabular-nums">{formatCurrency(s.saldo)}</strong>
        </div>
      ))}
    </div>
  );
}
