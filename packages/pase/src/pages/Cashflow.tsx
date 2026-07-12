// Cashflow.tsx — la "ruta del dinero" (módulo Cashflow).
//
// Tres vistas del mismo mes: Resumen (posición + ingresos/egresos + verificación),
// Libro contable (Debe|Haber|Saldo corrido + reclasificar), y el Puente
// (devengado ↔ cash). El upload de extracto se suma en la task siguiente.
// Todo el cálculo vive en las RPCs (lib/cashflow.ts).

import { useEffect, useState } from "react";
import { PageContainer, PageHeader, StatCard, Card, Modal } from "../components/ui";
import { fmt_$, todayAR_ISO } from "../lib/utils";
import { translateRpcError } from "../lib/errors";
import type { Usuario, Local } from "../types/auth";
import {
  resumenMes, libroMes, puenteMes, reclasificarMov, reclasificarLinea,
  subirExtracto, cerrarMes, CATEGORIA_LABEL,
  type CashflowResumen, type ResumenCategoria, type CashflowLibro,
  type CashflowPuente, type CashflowCategoria, type CashflowCuenta,
} from "../lib/cashflow";
import { mpLineasParaCashflow } from "../lib/mpExtractoParser";
import { bancoLineasParaCashflow } from "../lib/bancoExtractoParser";
import type { CashflowExtractoParseado } from "../lib/cashflowExtracto";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

type Tab = "resumen" | "libro" | "conciliacion" | "puente";

const TAB_LABEL: Record<Tab, string> = {
  resumen: "Resumen", libro: "Libro contable", conciliacion: "Conciliación", puente: "Puente",
};

const CATEGORIAS: CashflowCategoria[] = [
  "venta", "proveedor", "sueldo", "gasto", "comision", "retencion",
  "aporte_socio", "retiro_socio", "obra_capex", "transferencia_interna",
  "apertura_ajuste", "otro",
];

export default function Cashflow({ locales, localActivo }: Props) {
  const [mes, setMes] = useState<string>(() => todayAR_ISO().slice(0, 7)); // YYYY-MM
  const [localSel, setLocalSel] = useState<number | null>(localActivo ?? locales[0]?.id ?? null);
  const [tab, setTab] = useState<Tab>("resumen");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const lid = localActivo ?? localSel;
  const periodoMes = `${mes}-01`;
  const refresh = () => setRefreshKey((k) => k + 1);

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Cashflow"
        info={<>La ruta del dinero del mes: cuánto entró, salió y quedó — verificado contra los extractos. Distinto del EERR (que es devengado): esto es la plata que se movió de verdad.</>}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {localActivo == null && locales.length > 0 && (
              <select value={localSel ?? ""} onChange={(e) => setLocalSel(Number(e.target.value))} style={selStyle}>
                {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            )}
            <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} style={selStyle} />
            {lid && <button className="btn btn-acc" onClick={() => setUploadOpen(true)}>+ Subir extracto</button>}
          </div>
        }
      />

      <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "0.5px solid var(--pase-border)" }}>
        {(["resumen", "libro", "conciliacion", "puente"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {!lid && <div style={{ color: "var(--pase-text-muted)", padding: 24 }}>Elegí un local para ver la ruta del dinero.</div>}
      {lid && tab === "resumen" && <ResumenView lid={lid} periodoMes={periodoMes} refreshKey={refreshKey} onChanged={refresh} />}
      {lid && tab === "libro" && <LibroView lid={lid} periodoMes={periodoMes} refreshKey={refreshKey} />}
      {lid && tab === "conciliacion" && <ConciliacionView />}
      {lid && tab === "puente" && <PuenteView lid={lid} periodoMes={periodoMes} refreshKey={refreshKey} />}

      {lid && uploadOpen && (
        <UploadExtractoModal
          lid={lid} periodoMes={periodoMes}
          onClose={() => setUploadOpen(false)}
          onDone={() => { setUploadOpen(false); refresh(); }}
        />
      )}
    </PageContainer>
  );
}

/* ----------------------------- Subir extracto ----------------------------- */

function UploadExtractoModal({ lid, periodoMes, onClose, onDone }: {
  lid: number; periodoMes: string; onClose: () => void; onDone: () => void;
}) {
  const [cuenta, setCuenta] = useState<CashflowCuenta>("MercadoPago");
  const [parseado, setParseado] = useState<CashflowExtractoParseado | null>(null);
  const [archivo, setArchivo] = useState<string>("");
  const [estado, setEstado] = useState<"idle" | "parsing" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);

  const anio = Number(periodoMes.slice(0, 4));

  async function onFile(file: File | null) {
    if (!file) return;
    setError(null); setParseado(null); setArchivo(file.name); setEstado("parsing");
    try {
      const r = cuenta === "MercadoPago"
        ? await mpLineasParaCashflow(file)
        : await bancoLineasParaCashflow(file, anio);
      if (!r || r.lineas.length === 0) {
        setError("No pude leer movimientos del archivo. Revisá que sea el extracto correcto (MP: el .csv o .xlsx del panel; Banco: el PDF del resumen).");
      } else {
        setParseado(r);
      }
    } catch {
      setError("No pude procesar el archivo. Si es el PDF del banco, probá de nuevo o avisá.");
    }
    setEstado("idle");
  }

  async function confirmar() {
    if (!parseado) return;
    setEstado("uploading"); setError(null);
    const { error } = await subirExtracto({
      localId: lid, cuenta, periodoMes, parseado, archivoNombre: archivo,
      idempotencyKey: `${lid}-${cuenta}-${periodoMes}-${parseado.lineas.length}`,
    });
    setEstado("idle");
    if (error) setError(translateRpcError(error));
    else onDone();
  }

  return (
    <Modal isOpen onClose={onClose} title="Subir extracto" subtitle={`Período ${periodoMes.slice(0, 7)}`} preventCloseOnOverlay
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-acc" disabled={!parseado || estado === "uploading"} onClick={confirmar}>
            {estado === "uploading" ? "Subiendo…" : "Confirmar"}
          </button>
        </>
      }>
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Cuenta</span>
          <select value={cuenta} onChange={(e) => { setCuenta(e.target.value as CashflowCuenta); setParseado(null); }} style={selStyle}>
            <option value="MercadoPago">MercadoPago (.csv o .xlsx del panel)</option>
            <option value="Banco">Banco — BBVA o Galicia (.pdf del resumen)</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Archivo</span>
          <input type="file" accept={cuenta === "MercadoPago" ? ".csv,.xlsx,.xls" : ".pdf"}
            onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
        </label>

        {estado === "parsing" && <div style={subMuted}>Leyendo el archivo…</div>}
        {error && <div style={{ color: "#B91C1C", fontSize: "var(--pase-fs-sm)" }}>{error}</div>}

        {parseado && (
          <Card padding="md">
            <div style={cardTitle}>Vista previa</div>
            <div style={rowBetween}><span>Movimientos</span><b>{parseado.lineas.length}</b></div>
            <div style={rowBetween}><span>Saldo inicial</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(parseado.saldoInicial)}</span></div>
            <div style={rowBetween}><span>Saldo final</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(parseado.saldoFinal)}</span></div>
            {parseado.advertencias && parseado.advertencias.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {parseado.advertencias.map((a, i) => <div key={i} style={{ color: "#B45309", fontSize: "var(--pase-fs-xs)" }}>⚠️ {a}</div>)}
              </div>
            )}
            <div style={{ ...subMuted, marginTop: 8 }}>Al confirmar se clasifican solas; revisá y corregí en la pestaña "Libro contable" ({cuenta}).</div>
          </Card>
        )}
      </div>
    </Modal>
  );
}

/* ----------------------------- Resumen ----------------------------- */

function ResumenView({ lid, periodoMes, refreshKey, onChanged }: {
  lid: number; periodoMes: string; refreshKey: number; onChanged: () => void;
}) {
  const [resumen, setResumen] = useState<CashflowResumen | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cerrando, setCerrando] = useState(false);

  useEffect(() => {
    let cancel = false;
    setLoading(true); setError(null);
    resumenMes(lid, periodoMes).then(({ data, error }) => {
      if (cancel) return;
      if (error) setError(translateRpcError(error)); else setResumen(data);
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [lid, periodoMes, refreshKey]);

  async function cerrar() {
    if (!confirm("Cerrar y bloquear el mes? No se va a poder editar después.")) return;
    setCerrando(true);
    const { error } = await cerrarMes(lid, periodoMes, `${lid}-${periodoMes}`);
    setCerrando(false);
    if (error) setError(translateRpcError(error)); else onChanged();
  }

  if (error) return <Card padding="md"><div style={{ color: "#B91C1C" }}>{error}</div></Card>;
  if (!resumen && loading) return <Cargando />;
  if (!resumen) return null;
  const todoCuadra = resumen.extractos.length > 0 && resumen.extractos.every((e) => e.cuadra);

  const totalIngresos = sumCat(resumen.ingresos);
  const totalEgresos = sumCat(resumen.egresos);

  return (
    <div style={{ display: "grid", gap: 16, opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
      {resumen.bloqueado && (
        <Card padding="md"><span style={{ color: "var(--pase-celeste)", fontWeight: 500 }}>🔒 Mes cerrado y bloqueado.</span></Card>
      )}
      <div style={gridCards}>
        <StatCard variant="anchor" label="Líquido operativo" value={fmtM(resumen.posicion.liquido_operativo)} sub="efectivo + MercadoPago + banco" />
        <StatCard label="Reservado (Utilidades)" value={fmtM(resumen.posicion.reservado)} sub="apartado para repartir / fondo" />
        <StatCard label="En tránsito (a cobrar)" value={fmtM(resumen.en_transito.neto)} sub={`vendido ${fmtM(resumen.en_transito.bruto)} − acreditado ${fmtM(resumen.en_transito.acreditado)}`} />
        {resumen.por_revisar > 0 && (
          <StatCard label="Por revisar" value={String(resumen.por_revisar)} sub="movimientos manuales sin clasificar (ver Libro)" />
        )}
      </div>

      <ComposicionSaldo resumen={resumen} />

      <FlujoMes
        saldoIni={resumen.saldos_iniciales.efectivo + resumen.saldos_iniciales.mercadopago + resumen.saldos_iniciales.banco}
        saldoFin={resumen.posicion.liquido_operativo}
        ingresos={resumen.ingresos} egresos={resumen.egresos}
      />

      <div style={gridTwo}>
        <CategoriaList titulo={`Ingresos · ${fmt_$(totalIngresos)}`} items={resumen.ingresos} positivo />
        <CategoriaList titulo={`Egresos · ${fmt_$(totalEgresos)}`} items={resumen.egresos} />
      </div>

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

      {!resumen.bloqueado && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn" disabled={cerrando} onClick={cerrar}
            title={todoCuadra ? "" : "Conviene cerrar cuando todos los extractos cuadran"}>
            {cerrando ? "Cerrando…" : "🔒 Cerrar mes"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- Libro contable ----------------------------- */

const CUENTAS_LIBRO = [
  { value: "", label: "Efectivo (consolidado)" },
  { value: "Caja Chica", label: "Caja Chica" },
  { value: "Caja Mayor", label: "Caja Mayor" },
  { value: "Caja Efectivo", label: "Caja Efectivo (casa)" },
  { value: "CAJA UTILIDADES", label: "Caja Utilidades" },
  { value: "MercadoPago", label: "MercadoPago" },
  { value: "Banco", label: "Banco" },
];

function LibroView({ lid, periodoMes, refreshKey }: { lid: number; periodoMes: string; refreshKey: number }) {
  const [cuenta, setCuenta] = useState<string>("");
  const [libro, setLibro] = useState<CashflowLibro | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const esExtracto = cuenta === "MercadoPago" || cuenta === "Banco";

  useEffect(() => {
    let cancel = false;
    setLoading(true); setError(null);
    libroMes(lid, periodoMes, cuenta || null).then(({ data, error }) => {
      if (cancel) return;
      if (error) setError(translateRpcError(error)); else setLibro(data);
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [lid, periodoMes, cuenta, version, refreshKey]);

  async function reclasificar(refId: string, categoria: CashflowCategoria) {
    const r = esExtracto
      ? await reclasificarLinea({ lineaId: refId, categoria, aplicarTodas: true })
      : await reclasificarMov({ movId: refId, categoria, aplicarTodas: true });
    if (r.error) setError(translateRpcError(r.error));
    else setVersion((v) => v + 1);
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <select value={cuenta} onChange={(e) => setCuenta(e.target.value)} style={selStyle}>
          {CUENTAS_LIBRO.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        {libro && (
          <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
            Inicial {fmt_$(libro.saldo_inicial)} → Final <b style={{ color: "var(--pase-text)" }}>{fmt_$(libro.saldo_final)}</b>
          </span>
        )}
      </div>

      {error && <Card padding="md"><div style={{ color: "#B91C1C" }}>{error}</div></Card>}
      {!libro && loading && <Cargando />}
      {libro && (
        <Card padding="md">
          <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity .15s", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--pase-fs-sm)" }}>
              <thead>
                <tr style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)", textAlign: "left" }}>
                  <th style={thCell}>Fecha</th>
                  <th style={thCell}>Concepto</th>
                  <th style={thCell}>Categoría</th>
                  <th style={{ ...thCell, textAlign: "right" }}>Debe</th>
                  <th style={{ ...thCell, textAlign: "right" }}>Haber</th>
                  <th style={{ ...thCell, textAlign: "right" }}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {libro.filas.length === 0 && (
                  <tr><td colSpan={6} style={{ ...tdCell, color: "var(--pase-text-muted)" }}>Sin movimientos este mes.</td></tr>
                )}
                {libro.filas.map((f) => (
                  <tr key={f.ref_id} style={{ borderTop: "0.5px solid var(--pase-border)" }}>
                    <td style={tdCell}>{f.fecha.slice(8, 10)}/{f.fecha.slice(5, 7)}</td>
                    <td style={{ ...tdCell, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.concepto}</td>
                    <td style={tdCell}>
                      <select value={f.categoria ?? "otro"} onChange={(e) => reclasificar(f.ref_id, e.target.value as CashflowCategoria)}
                        style={{ ...selStyle, padding: "2px 6px", fontSize: "var(--pase-fs-xs)", ...(f.categoria === "otro" ? { borderColor: "#B91C1C" } : {}) }}>
                        {CATEGORIAS.map((c) => <option key={c} value={c}>{CATEGORIA_LABEL[c]}</option>)}
                      </select>
                    </td>
                    <td style={{ ...tdCell, textAlign: "right", color: "#B91C1C", fontVariantNumeric: "tabular-nums" }}>{f.debe ? fmt_$(f.debe) : ""}</td>
                    <td style={{ ...tdCell, textAlign: "right", color: "var(--pase-celeste)", fontVariantNumeric: "tabular-nums" }}>{f.haber ? fmt_$(f.haber) : ""}</td>
                    <td style={{ ...tdCell, textAlign: "right", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{fmt_$(f.saldo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ----------------------------- Puente ----------------------------- */

function PuenteView({ lid, periodoMes, refreshKey }: { lid: number; periodoMes: string; refreshKey: number }) {
  const [puente, setPuente] = useState<CashflowPuente | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true); setError(null);
    puenteMes(lid, periodoMes).then(({ data, error }) => {
      if (cancel) return;
      if (error) setError(translateRpcError(error)); else setPuente(data);
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [lid, periodoMes, refreshKey]);

  if (error) return <Card padding="md"><div style={{ color: "#B91C1C" }}>{error}</div></Card>;
  if (!puente && loading) return <Cargando />;
  if (!puente) return null;
  const d = puente.devengado;

  return (
    <div style={{ display: "grid", gap: 16, opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
      <Card padding="md">
        <div style={subMuted}>Por qué la ganancia del EERR (devengado) no es igual a la plata generada (cash). El EERR cuenta cuando comprás/vendés; el cashflow, cuando pagás/cobrás.</div>
      </Card>

      <Card padding="lg">
        <div style={cardTitle}>Ganancia devengada (EERR)</div>
        {([
          ["Ventas", d.ventas], ["− CMV", -d.cmv], ["− Gastos fijos", -d.gastos_fijos],
          ["− Gastos variables", -d.gastos_variables], ["− Sueldos", -d.sueldos],
          ["− Cargas sociales", -d.cargas_sociales], ["− Publicidad", -d.publicidad],
          ["− Comisiones", -d.comisiones], ["− Impuestos", -d.impuestos], ["− Otros", -d.otros],
        ] as const).map(([k, v]) => (
          <div key={k} style={rowBetween}><span>{k}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(v)}</span></div>
        ))}
        <div style={{ ...rowBetween, fontWeight: 500, borderTop: "0.5px solid var(--pase-border)", marginTop: 4, paddingTop: 8 }}>
          <span>Utilidad neta devengada</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(d.utilidad_neta)}</span>
        </div>
      </Card>

      <Card padding="lg">
        <div style={cardTitle}>El puente → cash real generado</div>
        {puente.puente.map((l, i) => (
          <div key={i} style={rowBetween}>
            <span>{l.concepto}{l.estimado ? <em style={{ color: "var(--pase-text-muted)" }}> (estimado)</em> : null}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(l.monto)}</span>
          </div>
        ))}
        <div style={{ ...rowBetween, fontWeight: 500, borderTop: "0.5px solid var(--pase-border)", marginTop: 4, paddingTop: 8 }}>
          <span>= Cash real generado</span>
          <span style={{ fontVariantNumeric: "tabular-nums", color: puente.cash_generado >= 0 ? "var(--pase-celeste)" : "#B91C1C" }}>{fmt_$(puente.cash_generado)}</span>
        </div>
      </Card>
      {puente.stock_estimado && (
        <div style={subMuted}>⚠️ La variación de stock está en $0 (estimado): cargá el inventario valorizado para afinar el puente.</div>
      )}
    </div>
  );
}

/* ----------------------------- Conciliación (UI, datos de ejemplo) ----------------------------- */

type EstadoConc = "conciliada" | "clasificar" | "falta" | "elegir" | "sobra" | "ignorada" | "diferencia";

interface FilaConc {
  id: string; fecha: string; concepto: string; categoria: string; categoriaVacia?: boolean;
  debe?: number; haber?: number; saldo?: number | null;
  estado: EstadoConc; sub?: string; acciones?: string[]; tachado?: boolean;
}

const CONC_COLOR: Record<EstadoConc, string> = {
  conciliada: "var(--pase-celeste)", clasificar: "#D97706", falta: "#B91C1C",
  elegir: "#D97706", sobra: "#B91C1C", ignorada: "var(--pase-text-muted)", diferencia: "#D97706",
};
// Cada estado cae en un grupo/pill; "diferencia" viaja con "faltan cargar".
const CONC_GRUPO: Record<EstadoConc, string> = {
  clasificar: "clasificar", falta: "falta", diferencia: "falta",
  elegir: "elegir", sobra: "sobra", ignorada: "ignorada", conciliada: "conciliada",
};
const CONC_PILLS = [
  { key: "todas", label: "Todas" }, { key: "clasificar", label: "Por clasificar" },
  { key: "falta", label: "Faltan cargar" }, { key: "elegir", label: "Por elegir" },
  { key: "sobra", label: "Sobran" }, { key: "ignorada", label: "Ignoradas" },
];
const CONC_GRUPO_ORDEN: { key: string; label: string; color: string }[] = [
  { key: "clasificar", label: "Por clasificar · ingresos", color: "#D97706" },
  { key: "falta", label: "Faltan cargar", color: "#B91C1C" },
  { key: "elegir", label: "Por elegir", color: "#D97706" },
  { key: "sobra", label: "Sobran en PASE", color: "#B91C1C" },
  { key: "ignorada", label: "Ignoradas", color: "var(--pase-text-muted)" },
  { key: "conciliada", label: "Conciliadas", color: "var(--pase-celeste)" },
];

const CONC_FILAS: FilaConc[] = [
  { id: "1", fecha: "01/06", concepto: "Liquidación de dinero", categoria: "Venta", haber: 223668.48, saldo: 3225781.15, estado: "conciliada" },
  { id: "2", fecha: "02/06", concepto: "Transferencia recibida Oscar Trejo", categoria: "— elegí —", categoriaVacia: true, haber: 105500, saldo: 3331281.15, estado: "clasificar", acciones: ["Venta", "Aporte de socio", "Transferencia interna"] },
  { id: "3", fecha: "02/06", concepto: "Pago RAPPI ARG SAS", categoria: "Comisiones", sub: "linkeado a Gasto #1042", debe: 42122, saldo: 3289159.15, estado: "conciliada" },
  { id: "4", fecha: "03/06", concepto: "Transferencia enviada CASA CHINA", categoria: "CMV", sub: "linkeado a Factura #A-0087", debe: 654047.59, saldo: 2635111.56, estado: "conciliada" },
  { id: "5", fecha: "03/06", concepto: "Transferencia enviada Lima Magica Srl", categoria: "CMV", debe: 170998.95, saldo: 2464112.61, estado: "falta", acciones: ["Marcar factura #F-2231 como pagada", "Linkear otra", "Crear gasto", "Ignorar"] },
  { id: "6", fecha: "03/06", concepto: "Compra Mercado Libre", categoria: "— sin cargar —", categoriaVacia: true, debe: 30000, saldo: 2434112.61, estado: "falta", acciones: ["Crear gasto", "Linkear factura", "Es de un proveedor…", "Ignorar"] },
  { id: "7", fecha: "04/06", concepto: "Transferencia enviada Emanuel Enecoiz", categoria: "CMV", debe: 464000, saldo: 1970112.61, estado: "elegir", sub: "2 pagos posibles con este monto", acciones: ["Elegir cuál"] },
  { id: "8", fecha: "—", concepto: "The Good Selection S.R.L", categoria: "10 pagos", saldo: null, estado: "diferencia", sub: "extracto −6.138.241,73 vs sistema −11.784.844,62 · 5.646.602,89 de más (¿mes anterior?)", acciones: ["Ver detalle"] },
  { id: "9", fecha: "28/05", concepto: "Pago SUL SRL · Fact 0017", categoria: "CMV", debe: 240015.80, saldo: null, estado: "sobra", sub: "Sólo en PASE, no está en el extracto", acciones: ["Anular", "Se pagó en efectivo", "Es de otro día"] },
  { id: "10", fecha: "02/06", concepto: "Impuesto por extracción", categoria: "Ignorada", debe: 600, saldo: 1969512.61, estado: "ignorada", tachado: true, sub: "impuesto bancario", acciones: ["Reactivar"] },
];

function ConciliacionView() {
  const [filtro, setFiltro] = useState<string>("todas");
  const [modo, setModo] = useState<"lista" | "agrupado">("lista");
  const [colapsados, setColapsados] = useState<Set<string>>(new Set());
  const toggleGrupo = (k: string) => setColapsados((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const cuenta = (k: string) => k === "todas" ? CONC_FILAS.length : CONC_FILAS.filter((f) => CONC_GRUPO[f.estado] === k).length;
  const visibles = filtro === "todas" ? CONC_FILAS : CONC_FILAS.filter((f) => CONC_GRUPO[f.estado] === filtro);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ ...selStyle, display: "inline-flex", alignItems: "center", gap: 8 }}>MercadoPago <span style={{ color: "var(--pase-text-muted)" }}>▾</span></span>
        <span style={{ fontSize: "var(--pase-fs-base)", color: "var(--pase-text-muted)" }}>
          Inicial <b style={{ color: "var(--pase-text)" }}>$3.002.112,67</b> → Final <b style={{ color: "var(--pase-text)" }}>$838.469,38</b> · <span style={{ color: "var(--pase-celeste)" }}>cuadra</span>
        </span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CONC_PILLS.map((p) => (
            <button key={p.key} onClick={() => setFiltro(p.key)} style={concPill(filtro === p.key)}>
              {p.label} <span style={{ opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>{cuenta(p.key)}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "inline-flex", padding: 3, background: "var(--pase-bg-soft)", borderRadius: 8, border: "0.5px solid var(--pase-border)" }}>
          {(["lista", "agrupado"] as const).map((m) => (
            <button key={m} onClick={() => setModo(m)} style={concSeg(modo === m)}>{m === "lista" ? "Lista" : "Agrupado"}</button>
          ))}
        </div>
      </div>

      <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: -6 }}>Vista preliminar — datos de ejemplo para ver el diseño.</div>

      <Card padding="md">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--pase-fs-sm)" }}>
            <thead>
              <tr style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)", textAlign: "left" }}>
                <th style={thCell}>Fecha</th><th style={thCell}>Concepto</th><th style={thCell}>Categoría</th>
                <th style={{ ...thCell, textAlign: "right" }}>Debe</th><th style={{ ...thCell, textAlign: "right" }}>Haber</th><th style={{ ...thCell, textAlign: "right" }}>Saldo</th>
              </tr>
            </thead>
            <tbody>
              {modo === "lista" && visibles.map((f) => <ConcFila key={f.id} f={f} />)}
              {modo === "agrupado" && CONC_GRUPO_ORDEN
                .filter((g) => filtro === "todas" || g.key === filtro)
                .flatMap((g) => {
                  const rows = CONC_FILAS.filter((f) => CONC_GRUPO[f.estado] === g.key);
                  if (rows.length === 0) return [];
                  const cerrado = colapsados.has(g.key);
                  const header = (
                    <tr key={"h-" + g.key} onClick={() => toggleGrupo(g.key)} style={{ cursor: "pointer", background: "var(--pase-bg-soft)" }}>
                      <td colSpan={6} style={{ padding: "7px 8px" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: "var(--pase-fs-sm)" }}>
                          <span style={{ display: "inline-block", transform: cerrado ? "rotate(-90deg)" : "none", transition: "transform .15s", color: "var(--pase-text-muted)" }}>▾</span>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: g.color }} />
                          <b style={{ color: "var(--pase-text)", fontWeight: 500 }}>{g.label}</b>
                          <span style={{ color: "var(--pase-text-muted)" }}>{rows.length}</span>
                        </span>
                      </td>
                    </tr>
                  );
                  return cerrado ? [header] : [header, ...rows.map((f) => <ConcFila key={f.id} f={f} />)];
                })}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={subMuted}>
        Cada acción impacta de verdad: clasificar un ingreso alimenta el Cashflow; linkear o crear un egreso alimenta el EERR y el P&L real. El puntito de color es el estado de cada línea.
      </div>
    </div>
  );
}

function ConcFila({ f }: { f: FilaConc }) {
  return (
    <tr style={{ borderTop: "0.5px solid var(--pase-border)" }}>
      <td style={{ ...tdCell, color: "var(--pase-text-muted)", whiteSpace: "nowrap" }}>{f.fecha}</td>
      <td style={tdCell}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: CONC_COLOR[f.estado], marginTop: 5, flex: "0 0 auto" }} />
          <div style={{ minWidth: 0 }}>
            <div style={f.tachado ? { textDecoration: "line-through", color: "var(--pase-text-muted)" } : undefined}>{f.concepto}</div>
            {(f.sub || f.acciones) && (
              <div style={{ marginTop: 3, fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", lineHeight: 1.5 }}>
                {f.sub && <span>{f.sub}{f.acciones ? " · " : ""}</span>}
                {f.acciones?.map((a, i) => (
                  <span key={i}>
                    <button style={concLink}>{a}</button>
                    {i < f.acciones!.length - 1 && <span style={{ color: "var(--pase-border-strong)", margin: "0 5px" }}>·</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </td>
      <td style={tdCell}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 8, border: "0.5px solid " + (f.categoriaVacia ? "#D97706" : "var(--pase-border-strong)"), fontSize: "var(--pase-fs-xs)", color: f.categoriaVacia ? "#D97706" : "var(--pase-text)", whiteSpace: "nowrap" }}>
          {f.categoria} <span style={{ color: "var(--pase-text-muted)" }}>▾</span>
        </span>
      </td>
      <td style={{ ...tdCell, textAlign: "right", color: "#B91C1C", fontVariantNumeric: "tabular-nums" }}>{f.debe ? fmt_$(f.debe) : ""}</td>
      <td style={{ ...tdCell, textAlign: "right", color: "var(--pase-celeste)", fontVariantNumeric: "tabular-nums" }}>{f.haber ? fmt_$(f.haber) : ""}</td>
      <td style={{ ...tdCell, textAlign: "right", fontWeight: 500, fontVariantNumeric: "tabular-nums", ...(f.saldo == null ? { color: "var(--pase-text-muted)" } : {}) }}>{f.saldo == null ? "—" : fmt_$(f.saldo)}</td>
    </tr>
  );
}

const concPill = (active: boolean): React.CSSProperties => ({
  fontSize: "var(--pase-fs-sm)", padding: "5px 12px", borderRadius: 999,
  border: "0.5px solid " + (active ? "transparent" : "var(--pase-border)"),
  background: active ? "var(--pase-celeste)" : "var(--pase-bg)",
  color: active ? "#fff" : "var(--pase-text-muted)", cursor: "pointer",
  fontFamily: "var(--pase-font)", display: "inline-flex", gap: 6, alignItems: "center",
});
const concSeg = (active: boolean): React.CSSProperties => ({
  fontSize: "var(--pase-fs-sm)", padding: "5px 13px", border: "none", borderRadius: 6, cursor: "pointer",
  background: active ? "var(--pase-bg)" : "transparent", color: active ? "var(--pase-text)" : "var(--pase-text-muted)",
  fontWeight: active ? 500 : 400, fontFamily: "var(--pase-font)",
});
const concLink: React.CSSProperties = {
  border: "none", background: "none", padding: 0, color: "var(--pase-celeste)", cursor: "pointer",
  fontSize: "var(--pase-fs-xs)", fontFamily: "var(--pase-font)",
};

/* ----------------------------- helpers ----------------------------- */

function Cargando() { return <div style={{ color: "var(--pase-text-muted)", padding: 24 }}>Cargando…</div>; }
function sumCat(items: ResumenCategoria[]): number { return items.reduce((s, i) => s + i.total, 0); }
/** Plata redondeada (sin centavos) para las tarjetas de posición — evita que los
 *  montos grandes se corten. El detalle exacto va en las tablas. */
function fmtM(n: number): string { return `$ ${Math.round(n).toLocaleString("es-AR")}`; }

const CUENTA_LABEL_CAJA: Record<string, string> = {
  "Caja Chica": "Caja Chica", "Caja Mayor": "Caja Mayor", "Caja Efectivo": "Efectivo (casa)",
  "MercadoPago": "MercadoPago", "Banco": "Banco", "CAJA UTILIDADES": "Caja Utilidades",
};

/** Cuadro transparente: por cada caja, saldo inicial + entradas − salidas = saldo final. */
function ComposicionSaldo({ resumen }: { resumen: CashflowResumen }) {
  const filas = resumen.flujo_cuentas ?? [];
  // Fallback si el backend viejo todavía no devuelve flujo_cuentas.
  if (filas.length === 0) {
    return (
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
    );
  }
  const tot = filas.reduce((a, f) => ({
    ini: a.ini + f.saldo_inicial, ent: a.ent + f.entradas, sal: a.sal + f.salidas, fin: a.fin + f.saldo_final,
  }), { ini: 0, ent: 0, sal: 0, fin: 0 });
  const numTd: React.CSSProperties = { ...tdCell, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  return (
    <Card padding="lg">
      <div style={cardTitle}>Cómo se compone el saldo</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--pase-fs-sm)", minWidth: 520 }}>
          <thead>
            <tr style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)" }}>
              <th style={{ ...thCell, textAlign: "left" }}>Caja</th>
              <th style={{ ...thCell, textAlign: "right" }}>Saldo inicial</th>
              <th style={{ ...thCell, textAlign: "right" }}>+ Entradas</th>
              <th style={{ ...thCell, textAlign: "right" }}>− Salidas</th>
              <th style={{ ...thCell, textAlign: "right" }}>= Saldo final</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.cuenta} style={{ borderTop: "0.5px solid var(--pase-border)" }}>
                <td style={tdCell}>{CUENTA_LABEL_CAJA[f.cuenta] ?? f.cuenta}</td>
                <td style={numTd}>{fmt_$(f.saldo_inicial)}</td>
                <td style={{ ...numTd, color: "var(--pase-celeste)" }}>{fmt_$(f.entradas)}</td>
                <td style={{ ...numTd, color: "#B91C1C" }}>{fmt_$(f.salidas)}</td>
                <td style={{ ...numTd, fontWeight: 500 }}>{fmt_$(f.saldo_final)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "1px solid var(--pase-border)", fontWeight: 500 }}>
              <td style={tdCell}>Total</td>
              <td style={numTd}>{fmt_$(tot.ini)}</td>
              <td style={{ ...numTd, color: "var(--pase-celeste)" }}>{fmt_$(tot.ent)}</td>
              <td style={{ ...numTd, color: "#B91C1C" }}>{fmt_$(tot.sal)}</td>
              <td style={numTd}>{fmt_$(tot.fin)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div style={{ ...subMuted, marginTop: 8 }}>Cada caja: saldo inicial + lo que entró − lo que salió = saldo final. Las entradas/salidas de efectivo incluyen movimientos entre tus propias cajas.</div>
    </Card>
  );
}

function CategoriaList({ titulo, items, positivo }: { titulo: string; items: ResumenCategoria[]; positivo?: boolean }) {
  return (
    <Card padding="lg">
      <div style={cardTitle}>{titulo}</div>
      {items.length === 0 && <div style={subMuted}>Sin movimientos.</div>}
      {items.map((i) => (
        <div key={i.categoria} style={rowBetween}>
          <span>{CATEGORIA_LABEL[i.categoria] ?? i.categoria}</span>
          <span style={{ fontVariantNumeric: "tabular-nums", color: positivo ? "var(--pase-celeste)" : "var(--pase-text)" }}>{fmt_$(i.total)}</span>
        </div>
      ))}
    </Card>
  );
}

function FlujoMes({ saldoIni, saldoFin, ingresos, egresos }: {
  saldoIni: number; saldoFin: number; ingresos: ResumenCategoria[]; egresos: ResumenCategoria[];
}) {
  const items = [
    ...ingresos.map((i) => ({ ...i, signo: 1 as const })),
    ...egresos.map((e) => ({ ...e, signo: -1 as const })),
  ].sort((a, b) => b.total - a.total);
  if (items.length === 0) return null;
  const max = Math.max(1, ...items.map((i) => i.total));
  return (
    <Card padding="lg">
      <div style={cardTitle}>Flujo del mes</div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={subMuted}>Saldo inicial</span>
        <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(saldoIni)}</b>
      </div>
      {items.map((it, i) => (
        <div key={`${it.categoria}-${i}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0" }}>
          <span style={{ flex: "0 0 140px", fontSize: "var(--pase-fs-sm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {it.signo > 0 ? "▲" : "▼"} {CATEGORIA_LABEL[it.categoria] ?? it.categoria}
          </span>
          <div style={{ flex: 1, height: 14, background: "rgba(127,127,127,0.12)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${Math.max(2, (it.total / max) * 100)}%`, height: "100%", background: it.signo > 0 ? "var(--pase-celeste)" : "#E06666" }} />
          </div>
          <span style={{ flex: "0 0 120px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: "var(--pase-fs-sm)", color: it.signo > 0 ? "var(--pase-celeste)" : "#B91C1C" }}>
            {it.signo > 0 ? "+" : "−"}{fmt_$(it.total)}
          </span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 8, borderTop: "0.5px solid var(--pase-border)", fontWeight: 500 }}>
        <span>Saldo final (líquido)</span>
        <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(saldoFin)}</b>
      </div>
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
const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: "8px 14px", border: "none", background: "none", cursor: "pointer",
  fontFamily: "var(--pase-font)", fontSize: "var(--pase-fs-sm)", fontWeight: active ? 500 : 400,
  color: active ? "var(--pase-text)" : "var(--pase-text-muted)",
  borderBottom: active ? "2px solid var(--pase-celeste)" : "2px solid transparent", marginBottom: -1,
});
const gridCards: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 };
const gridTwo: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 };
const cardTitle: React.CSSProperties = { fontSize: "var(--pase-fs-sm)", fontWeight: 500, color: "var(--pase-text-muted)", marginBottom: 10 };
const thMuted: React.CSSProperties = { fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", paddingBottom: 4, borderBottom: "0.5px solid var(--pase-border)" };
const subMuted: React.CSSProperties = { fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 4 };
const rowBetween: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "0.5px solid var(--pase-border)" };
const thCell: React.CSSProperties = { padding: "4px 8px", fontWeight: 400 };
const tdCell: React.CSSProperties = { padding: "5px 8px" };
