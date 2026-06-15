// Cashflow.tsx — la "ruta del dinero" (módulo Cashflow).
//
// Vista mensual: posición (líquido operativo / reservado / en tránsito), saldos
// por cuenta, ingresos/egresos por categoría, "Por revisar", y la verificación
// contra el extracto. El libro contable, el upload de extracto y el puente se
// suman en tasks siguientes. Todo el cálculo vive en las RPCs (lib/cashflow.ts).

import { useEffect, useState } from "react";
import { PageContainer, PageHeader, StatCard, Card } from "../components/ui";
import { fmt_$, todayAR_ISO } from "../lib/utils";
import { translateRpcError } from "../lib/errors";
import type { Usuario, Local } from "../types/auth";
import {
  resumenMes, CATEGORIA_LABEL,
  type CashflowResumen, type ResumenCategoria,
} from "../lib/cashflow";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

export default function Cashflow({ locales, localActivo }: Props) {
  const [mes, setMes] = useState<string>(() => todayAR_ISO().slice(0, 7)); // YYYY-MM
  const [localSel, setLocalSel] = useState<number | null>(localActivo ?? locales[0]?.id ?? null);
  const [resumen, setResumen] = useState<CashflowResumen | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lid = localActivo ?? localSel;
  const periodoMes = `${mes}-01`;

  useEffect(() => {
    if (!lid) return;
    let cancel = false;
    setLoading(true);
    setError(null);
    resumenMes(lid, periodoMes).then(({ data, error }) => {
      if (cancel) return;
      if (error) setError(translateRpcError(error));
      else setResumen(data);
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [lid, periodoMes]);

  const totalIngresos = resumen ? sumCat(resumen.ingresos) : 0;
  const totalEgresos = resumen ? sumCat(resumen.egresos) : 0;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Cashflow"
        info={<>La ruta del dinero del mes: cuánto entró, salió y quedó — verificado contra los extractos. Distinto del EERR (que es devengado): esto es la plata que se movió de verdad.</>}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {localActivo == null && locales.length > 0 && (
              <select
                value={localSel ?? ""}
                onChange={(e) => setLocalSel(Number(e.target.value))}
                style={selStyle}
              >
                {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            )}
            <input
              type="month"
              value={mes}
              onChange={(e) => setMes(e.target.value)}
              style={selStyle}
            />
          </div>
        }
      />

      {error && (
        <Card padding="md">
          <div style={{ color: "#B91C1C" }}>{error}</div>
        </Card>
      )}

      {!resumen && loading && <div style={{ color: "var(--pase-text-muted)", padding: 24 }}>Cargando…</div>}
      {!resumen && !loading && !error && <div style={{ color: "var(--pase-text-muted)", padding: 24 }}>Elegí un mes para ver la ruta del dinero.</div>}

      {resumen && (
        <div style={{ display: "grid", gap: 16, opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
          {resumen.bloqueado && (
            <Card padding="md">
              <span style={{ color: "var(--pase-celeste)", fontWeight: 500 }}>🔒 Mes cerrado y bloqueado.</span>
            </Card>
          )}

          {/* Posición */}
          <div style={gridCards}>
            <StatCard variant="anchor" label="Líquido operativo"
              value={fmt_$(resumen.posicion.liquido_operativo)}
              sub="efectivo + MercadoPago + banco" />
            <StatCard label="Reservado (Utilidades)"
              value={fmt_$(resumen.posicion.reservado)}
              sub="apartado para repartir / fondo" />
            <StatCard label="En tránsito (a cobrar)"
              value={fmt_$(resumen.en_transito.neto)}
              sub={`vendido ${fmt_$(resumen.en_transito.bruto)} − acreditado ${fmt_$(resumen.en_transito.acreditado)}`} />
            {resumen.por_revisar > 0 && (
              <StatCard label="Por revisar"
                value={String(resumen.por_revisar)}
                sub="movimientos manuales sin clasificar" />
            )}
          </div>

          {/* Saldos por cuenta */}
          <Card padding="lg">
            <div style={cardTitle}>Saldos por cuenta</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "4px 24px", alignItems: "baseline" }}>
              <div style={thMuted}>Cuenta</div>
              <div style={{ ...thMuted, textAlign: "right" }}>Saldo inicial</div>
              <div style={{ ...thMuted, textAlign: "right" }}>Saldo final</div>
              {([
                ["Efectivo", resumen.saldos_iniciales.efectivo, resumen.saldos_finales.efectivo],
                ["MercadoPago", resumen.saldos_iniciales.mercadopago, resumen.saldos_finales.mercadopago],
                ["Banco", resumen.saldos_iniciales.banco, resumen.saldos_finales.banco],
                ["Caja Utilidades", resumen.saldos_iniciales.utilidades, resumen.saldos_finales.utilidades],
              ] as const).map(([nombre, ini, fin]) => (
                <Row3 key={nombre} a={nombre} b={fmt_$(ini)} c={fmt_$(fin)} />
              ))}
            </div>
          </Card>

          {/* Ingresos / Egresos */}
          <div style={gridTwo}>
            <CategoriaList titulo={`Ingresos · ${fmt_$(totalIngresos)}`} items={resumen.ingresos} positivo />
            <CategoriaList titulo={`Egresos · ${fmt_$(totalEgresos)}`} items={resumen.egresos} />
          </div>

          {/* Retiros / Aportes (separados, anti-mezcla) */}
          {(resumen.retiros_total > 0 || resumen.aportes_total > 0) && (
            <div style={gridTwo}>
              <Card padding="md">
                <div style={cardTitle}>Retiros de socios</div>
                <div style={{ fontSize: "var(--pase-fs-xl)", fontWeight: 500, color: "#B91C1C" }}>{fmt_$(resumen.retiros_total)}</div>
                <div style={subMuted}>Reparto (se gestiona en Utilidades). No es gasto operativo.</div>
              </Card>
              <Card padding="md">
                <div style={cardTitle}>Aportes de socios</div>
                <div style={{ fontSize: "var(--pase-fs-xl)", fontWeight: 500, color: "var(--pase-celeste)" }}>{fmt_$(resumen.aportes_total)}</div>
                <div style={subMuted}>Plata que un socio puso. Financiación, no venta.</div>
              </Card>
            </div>
          )}

          {/* Verificación contra extracto */}
          {resumen.extractos.length > 0 && (
            <Card padding="lg">
              <div style={cardTitle}>Verificación contra el extracto</div>
              {resumen.extractos.map((e) => (
                <div key={e.cuenta} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "0.5px solid var(--pase-border)" }}>
                  <span>{e.cuenta}</span>
                  <span style={{ color: e.cuadra ? "var(--pase-celeste)" : "#B91C1C", fontVariantNumeric: "tabular-nums" }}>
                    {e.cuadra ? "✓ cuadra" : `✗ diferencia ${fmt_$(e.diferencia)}`}
                  </span>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}
    </PageContainer>
  );
}

function sumCat(items: ResumenCategoria[]): number {
  return items.reduce((s, i) => s + i.total, 0);
}

function CategoriaList({ titulo, items, positivo }: { titulo: string; items: ResumenCategoria[]; positivo?: boolean }) {
  return (
    <Card padding="lg">
      <div style={cardTitle}>{titulo}</div>
      {items.length === 0 && <div style={subMuted}>Sin movimientos.</div>}
      {items.map((i) => (
        <div key={i.categoria} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "0.5px solid var(--pase-border)" }}>
          <span>{CATEGORIA_LABEL[i.categoria] ?? i.categoria}</span>
          <span style={{ fontVariantNumeric: "tabular-nums", color: positivo ? "var(--pase-celeste)" : "var(--pase-text)" }}>{fmt_$(i.total)}</span>
        </div>
      ))}
    </Card>
  );
}

function Row3({ a, b, c }: { a: string; b: string; c: string }) {
  return (
    <>
      <div>{a}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{b}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c}</div>
    </>
  );
}

const selStyle: React.CSSProperties = {
  padding: "6px 10px", borderRadius: 8, border: "0.5px solid var(--pase-border)",
  background: "var(--pase-surface)", color: "var(--pase-text)", fontFamily: "var(--pase-font)", fontSize: "var(--pase-fs-sm)",
};
const gridCards: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 };
const gridTwo: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 };
const cardTitle: React.CSSProperties = { fontSize: "var(--pase-fs-sm)", fontWeight: 500, color: "var(--pase-text-muted)", marginBottom: 10 };
const thMuted: React.CSSProperties = { fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", paddingBottom: 4, borderBottom: "0.5px solid var(--pase-border)" };
const subMuted: React.CSSProperties = { fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 4 };
