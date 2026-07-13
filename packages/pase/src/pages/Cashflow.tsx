// Cashflow.tsx — la "ruta del dinero" (módulo Cashflow).
//
// Tres vistas del mismo mes: Resumen (posición + ingresos/egresos + verificación),
// Libro contable (Debe|Haber|Saldo corrido + reclasificar), y el Puente
// (devengado ↔ cash). El upload de extracto se suma en la task siguiente.
// Todo el cálculo vive en las RPCs (lib/cashflow.ts).

import { useEffect, useState } from "react";
import { db } from "../lib/supabase";
import { PageContainer, PageHeader, StatCard, Card, Modal } from "../components/ui";
import { fmt_$, todayAR_ISO } from "../lib/utils";
import { translateRpcError } from "../lib/errors";
import type { Usuario, Local } from "../types/auth";
import {
  resumenMes, pylMes, subirExtracto, cerrarMes, CATEGORIA_LABEL,
  type CashflowResumen, type ResumenCategoria, type CashflowCuenta,
  type CashflowPyl, type PylLinea,
} from "../lib/cashflow";
import { useCategorias } from "../lib/useCategorias";
import { mpLineasParaCashflow } from "../lib/mpExtractoParser";
import { bancoLineasParaCashflow } from "../lib/bancoExtractoParser";
import type { CashflowExtractoParseado } from "../lib/cashflowExtracto";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

type Tab = "resumen" | "ganancia" | "conciliacion";

const TAB_LABEL: Record<Tab, string> = {
  resumen: "Resumen", ganancia: "Ganancia real", conciliacion: "Conciliación",
};

export default function Cashflow({ locales, localActivo }: Props) {
  const [mes, setMes] = useState<string>(() => todayAR_ISO().slice(0, 7)); // YYYY-MM
  const [localSel, setLocalSel] = useState<number | null>(localActivo ?? locales[0]?.id ?? null);
  const [tab, setTab] = useState<Tab>("resumen");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Candado anti-traspapeleo: si cambia la sucursal activa (sidebar), sincronizar
  // localSel para que el `lid` NUNCA quede apuntando a un local viejo al subir.
  useEffect(() => { if (localActivo != null) setLocalSel(localActivo); }, [localActivo]);

  const lid = localActivo ?? localSel;
  const localNombre = locales.find((l) => l.id === lid)?.nombre ?? "";
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
        {(["resumen", "ganancia", "conciliacion"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {!lid && <div style={{ color: "var(--pase-text-muted)", padding: 24 }}>Elegí un local para ver la ruta del dinero.</div>}
      {lid && tab === "resumen" && <ResumenView lid={lid} periodoMes={periodoMes} refreshKey={refreshKey} onChanged={refresh} />}
      {lid && tab === "ganancia" && <GananciaView lid={lid} periodoMes={periodoMes} refreshKey={refreshKey} />}
      {lid && tab === "conciliacion" && <ConciliacionView lid={lid} periodoMes={periodoMes} />}

      {lid && uploadOpen && (
        <UploadExtractoModal
          lid={lid} localNombre={localNombre} periodoMes={periodoMes}
          onClose={() => setUploadOpen(false)}
          onDone={() => { setUploadOpen(false); refresh(); }}
        />
      )}
    </PageContainer>
  );
}

/* ----------------------------- Subir extracto ----------------------------- */

function UploadExtractoModal({ lid, localNombre, periodoMes, onClose, onDone }: {
  lid: number; localNombre: string; periodoMes: string; onClose: () => void; onDone: () => void;
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
    <Modal isOpen onClose={onClose} title="Subir extracto" subtitle={`${localNombre} · ${periodoMes.slice(0, 7)}`} preventCloseOnOverlay
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-acc" disabled={!parseado || estado === "uploading"} onClick={confirmar}>
            {estado === "uploading" ? "Subiendo…" : "Confirmar"}
          </button>
        </>
      }>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ padding: "9px 12px", borderRadius: 8, background: "var(--pase-celeste-100)", border: "0.5px solid var(--pase-celeste)", fontSize: "var(--pase-fs-sm)", color: "var(--pase-text)" }}>
          Se carga en la sucursal <b>{localNombre}</b>. Verificá que sea la correcta — queda anclado acá y no se traspapela.
        </div>
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

/* ----------------------------- Ganancia real vs teórica (P&L) ----------------------------- */

const PYL_LINEAS: [string, keyof PylLinea, 1 | -1][] = [
  ["Ventas", "ventas", 1], ["− CMV", "cmv", -1], ["− Gastos fijos", "gastos_fijos", -1],
  ["− Gastos variables", "gastos_variables", -1], ["− Sueldos", "sueldos", -1],
  ["− Cargas sociales", "cargas_sociales", -1], ["− Publicidad", "publicidad", -1],
  ["− Comisiones", "comisiones", -1], ["− Impuestos", "impuestos", -1], ["− Otros", "otros", -1],
];

function GananciaView({ lid, periodoMes, refreshKey }: { lid: number; periodoMes: string; refreshKey: number }) {
  const [pyl, setPyl] = useState<CashflowPyl | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true); setError(null);
    pylMes(lid, periodoMes).then(({ data, error }) => {
      if (cancel) return;
      if (error) setError(translateRpcError(error)); else setPyl(data);
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [lid, periodoMes, refreshKey]);

  if (error) return <Card padding="md"><div style={{ color: "#B91C1C" }}>{error}</div></Card>;
  if (!pyl && loading) return <Cargando />;
  if (!pyl) return null;
  const d = pyl.devengado, p = pyl.percibido;
  const utilColor = (n: number) => (n >= 0 ? "var(--pase-celeste)" : "#B91C1C");

  return (
    <div style={{ display: "grid", gap: 16, opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
      <Card padding="md">
        <div style={subMuted}>La misma estructura del EERR, en dos columnas: la ganancia <b>teórica</b> (devengada — cuando comprás/vendés) y la <b>real</b> (percibida — cuando pagás/cobrás de verdad).</div>
      </Card>

      <Card padding="lg">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--pase-fs-base)" }}>
            <thead>
              <tr style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)", textAlign: "left" }}>
                <th style={thCell}></th>
                <th style={{ ...thCell, textAlign: "right" }}>Teórica (EERR)</th>
                <th style={{ ...thCell, textAlign: "right" }}>Real (caja)</th>
              </tr>
            </thead>
            <tbody>
              {PYL_LINEAS.map(([label, key, signo]) => (
                <tr key={key} style={{ borderTop: "0.5px solid var(--pase-border)" }}>
                  <td style={tdCell}>{label}</td>
                  <td style={{ ...tdCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt_$(signo * d[key])}</td>
                  <td style={{ ...tdCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt_$(signo * p[key])}</td>
                </tr>
              ))}
              <tr style={{ borderTop: "1.5px solid var(--pase-border-strong)", fontWeight: 500 }}>
                <td style={{ ...tdCell, fontWeight: 500 }}>= Utilidad</td>
                <td style={{ ...tdCell, textAlign: "right", fontVariantNumeric: "tabular-nums", color: utilColor(d.utilidad) }}>{fmt_$(d.utilidad)}</td>
                <td style={{ ...tdCell, textAlign: "right", fontVariantNumeric: "tabular-nums", color: utilColor(p.utilidad) }}>{fmt_$(p.utilidad)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div style={subMuted}>La diferencia entre las dos utilidades es tu capital de trabajo: lo que vendiste y todavía no cobraste (tarjetas), lo que compraste y todavía no pagaste, stock, sueldos adelantados. Los egresos reales salen de las facturas/gastos cargados, por fecha de pago — mantené la conciliación al día para que no falte nada.</div>
    </div>
  );
}

/* ----------------------------- Conciliación (UI, datos de ejemplo) ----------------------------- */

type EstadoConc = "conciliada" | "clasificar" | "falta" | "elegir" | "sobra" | "ignorada" | "diferencia";

interface FilaConcRaw {
  fecha: string; monto: number; descripcion: string;
  movId?: string; facturas?: Array<{ tipo: string; id: string; total: number; nro?: string | null }>;
}
interface FilaConc {
  id: string; fecha: string; concepto: string; categoria: string; categoriaVacia?: boolean;
  estadoLabel?: string;
  debe?: number; haber?: number; saldo?: number | null;
  estado: EstadoConc; sub?: string; tachado?: boolean; raw?: FilaConcRaw;
}

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

// Cruce real que devuelve fn_cruzar_extracto_mp (shape mínima que consumimos).
interface FactPend { tipo: string; id?: string; nro?: string | null; total?: number; facturas?: Array<{ id: string; nro: string | null; total: number }> }
interface CruceFila {
  idx: number; fecha: string; monto: number; descripcion: string;
  estado: string; num_candidatos: number;
  bloque: { proveedor: string; suma_extracto: number; suma_pase: number | null; dif: number } | null;
  facturas_pendientes?: FactPend[];
}
interface CruceSobra { id: string; fecha: string; importe: number; detalle: string }
interface CruceLite { extracto: CruceFila[]; sobrantes: CruceSobra[] }

const EST_LABEL: Record<EstadoConc, string> = {
  conciliada: "Conciliada", clasificar: "Por clasificar", falta: "Falta cargar",
  elegir: "Por elegir", sobra: "Sobra en PASE", ignorada: "Ignorada", diferencia: "Diferencia",
};
const EST_TXT_COLOR: Record<EstadoConc, string> = {
  conciliada: "var(--pase-celeste)", clasificar: "#D97706", falta: "#B91C1C",
  elegir: "#D97706", sobra: "#B91C1C", ignorada: "var(--pase-text-muted)", diferencia: "#D97706",
};

function fmtDDMM(f: string): string { return f && f.length >= 10 ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : f; }

/** Traduce el resultado del motor probado (fn_cruzar_extracto_mp) a filas de la vista. */
function mapCruce(cruce: CruceLite): FilaConc[] {
  const estOf = (e: string): EstadoConc =>
    e.startsWith("verde") || e === "ya_conciliada" ? "conciliada"
      : e.startsWith("amarillo") ? "elegir"
        : e === "bloque_diferencia" ? "diferencia" : "falta";
  const out: FilaConc[] = [];
  for (const f of cruce.extracto ?? []) {
    const e = estOf(f.estado);
    let sub: string | undefined;
    if (e === "elegir") sub = `${f.num_candidatos} pago(s) posible(s) en el sistema con este monto`;
    else if (f.estado === "factura_sin_pagar") sub = "Tiene una factura pendiente de pago que coincide";
    else if (e === "falta") sub = "Salió del banco, no está cargado en el sistema";
    else if (e === "diferencia" && f.bloque)
      sub = `${f.bloque.proveedor}: extracto ${fmt_$(f.bloque.suma_extracto)} vs sistema ${f.bloque.suma_pase == null ? "—" : fmt_$(f.bloque.suma_pase)} · dif ${fmt_$(f.bloque.dif)}`;
    const facturas: NonNullable<FilaConcRaw["facturas"]> = [];
    for (const fp of f.facturas_pendientes ?? []) {
      if (fp.facturas) for (const inner of fp.facturas) facturas.push({ tipo: "factura", id: inner.id, total: inner.total, nro: inner.nro });
      else if (fp.id) facturas.push({ tipo: fp.tipo, id: fp.id, total: fp.total ?? Math.abs(f.monto), nro: fp.nro ?? null });
    }
    out.push({
      id: `ext-${f.idx}`, fecha: fmtDDMM(f.fecha), concepto: f.descripcion, categoria: "",
      estadoLabel: EST_LABEL[e], estado: e, sub,
      debe: f.monto < 0 ? Math.abs(f.monto) : undefined,
      haber: f.monto > 0 ? f.monto : undefined, saldo: null,
      raw: { fecha: f.fecha, monto: f.monto, descripcion: f.descripcion, facturas: facturas.length ? facturas : undefined },
    });
  }
  for (const s of cruce.sobrantes ?? []) {
    out.push({
      id: `sob-${s.id}`, fecha: fmtDDMM(s.fecha), concepto: s.detalle, categoria: "",
      estadoLabel: EST_LABEL.sobra, estado: "sobra", sub: "Cargado en el sistema, no está en el extracto",
      debe: Math.abs(s.importe), saldo: null,
      raw: { fecha: s.fecha, monto: s.importe, descripcion: s.detalle, movId: s.id },
    });
  }
  return out;
}

function ConciliacionView({ lid, periodoMes }: { lid: number; periodoMes: string }) {
  const [cuenta, setCuenta] = useState<string>("MercadoPago");
  const [filas, setFilas] = useState<FilaConc[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<string>("todas");
  const [modo, setModo] = useState<"lista" | "agrupado">("lista");
  const [colapsados, setColapsados] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const [crearGasto, setCrearGasto] = useState<FilaConc | null>(null);
  const mesTxt = periodoMes.slice(0, 7);
  const toggleGrupo = (k: string) => setColapsados((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // Carga real: trae las líneas del extracto MP guardado y las cruza con el
  // motor PROBADO (fn_cruzar_extracto_mp) — la misma lógica de /conciliacion-extracto.
  useEffect(() => {
    let cancel = false;
    if (cuenta !== "MercadoPago") { setFilas([]); setError(null); return; }
    setLoading(true); setError(null);
    (async () => {
      const mes = periodoMes.slice(0, 7);
      const [y, m] = mes.split("-").map(Number) as [number, number];
      const hasta = `${mes}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
      const { data: lineas, error: e1 } = await db
        .from("cashflow_lineas")
        .select("fecha, descripcion, monto_bruto, cashflow_extractos!inner(local_id, periodo_mes, cuenta)")
        .eq("cashflow_extractos.local_id", lid)
        .eq("cashflow_extractos.periodo_mes", periodoMes)
        .eq("cashflow_extractos.cuenta", "MercadoPago");
      if (cancel) return;
      if (e1) { setError(translateRpcError(e1.message)); setLoading(false); return; }
      const payload = ((lineas as { fecha: string; descripcion: string; monto_bruto: number }[] | null) ?? [])
        .map((l) => ({ fecha: l.fecha, monto: l.monto_bruto, descripcion: l.descripcion, referencia_externa: null }));
      if (payload.length === 0) { setFilas([]); setLoading(false); return; }
      const { data, error } = await db.rpc("fn_cruzar_extracto_mp", {
        p_local_id: lid, p_periodo_desde: periodoMes, p_periodo_hasta: hasta,
        p_movs_extracto: payload, p_solo_egresos: true, p_match_agrupado: true,
      });
      if (cancel) return;
      if (error) setError(translateRpcError(error.message));
      else setFilas(mapCruce(data as CruceLite));
      setLoading(false);
    })();
    return () => { cancel = true; };
  }, [lid, periodoMes, cuenta, version]);

  const contar = (k: string) => k === "todas" ? filas.length : filas.filter((f) => CONC_GRUPO[f.estado] === k).length;
  const visibles = filtro === "todas" ? filas : filas.filter((f) => CONC_GRUPO[f.estado] === filtro);

  // Acciones — reusan las RPCs probadas de /conciliacion-extracto.
  async function anular(f: FilaConc) {
    if (!f.raw?.movId) return;
    const motivo = window.prompt("Motivo de la anulación:");
    if (!motivo || !motivo.trim()) return;
    const { error } = await db.rpc("anular_movimiento", { p_mov_id: f.raw.movId, p_motivo: `[Conciliación ${mesTxt}] ${motivo.trim()}` });
    if (error) { setError(translateRpcError(error.message)); return; }
    setVersion((v) => v + 1);
  }
  async function pagarFacturas(f: FilaConc) {
    const facturas = f.raw?.facturas;
    if (!facturas?.length || !f.raw) return;
    if (!window.confirm(`¿Marcar ${facturas.length} comprobante(s) como pagado(s) por MercadoPago?`)) return;
    for (const fac of facturas) {
      const { error } = fac.tipo === "remito"
        ? await db.rpc("pagar_remito", { p_remito_id: fac.id, p_monto: fac.total, p_cuenta: "MercadoPago", p_fecha: f.raw.fecha, p_idempotency_key: crypto.randomUUID() })
        : await db.rpc("pagar_factura", { p_factura_id: fac.id, p_monto: fac.total, p_cuenta: "MercadoPago", p_fecha: f.raw.fecha, p_detalle: `[Concil. ${mesTxt}] ${f.concepto}`, p_idempotency_key: crypto.randomUUID(), p_generar_saldo: false, p_cerrar_factura: false });
      if (error) { setError(translateRpcError(error.message)); return; }
    }
    setVersion((v) => v + 1);
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <select value={cuenta} onChange={(e) => setCuenta(e.target.value)} style={selStyle}>
          <option value="Efectivo">Efectivo</option>
          <option value="MercadoPago">MercadoPago</option>
          <option value="Banco">Banco</option>
        </select>
        <span style={{ fontSize: "var(--pase-fs-base)", color: "var(--pase-text-muted)" }}>
          {filas.length} movimientos del extracto
        </span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CONC_PILLS.map((p) => (
            <button key={p.key} onClick={() => setFiltro(p.key)} style={concPill(filtro === p.key)}>
              {p.label} <span style={{ opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>{contar(p.key)}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "inline-flex", padding: 3, background: "var(--pase-bg-soft)", borderRadius: 8, border: "0.5px solid var(--pase-border)" }}>
          {(["lista", "agrupado"] as const).map((m) => (
            <button key={m} onClick={() => setModo(m)} style={concSeg(modo === m)}>{m === "lista" ? "Lista" : "Agrupado"}</button>
          ))}
        </div>
      </div>

      {loading && <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: -6 }}>Cruzando el extracto contra el sistema…</div>}
      {error && <Card padding="md"><div style={{ color: "#B91C1C" }}>{error}</div></Card>}
      {cuenta !== "MercadoPago" && <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: -6 }}>Por ahora la conciliación automática es solo de MercadoPago — la del banco viene en el próximo paso.</div>}
      {!loading && !error && cuenta === "MercadoPago" && filas.length === 0 && <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: -6 }}>No hay extracto de MercadoPago cargado para este mes. Subilo con "+ Subir extracto".</div>}

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
              {modo === "lista" && visibles.map((f) => <ConcFila key={f.id} f={f} onCrear={() => setCrearGasto(f)} onPagar={() => pagarFacturas(f)} onAnular={() => anular(f)} />)}
              {modo === "agrupado" && CONC_GRUPO_ORDEN
                .filter((g) => filtro === "todas" || g.key === filtro)
                .flatMap((g) => {
                  const rows = filas.filter((f) => CONC_GRUPO[f.estado] === g.key);
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
                  return cerrado ? [header] : [header, ...rows.map((f) => <ConcFila key={f.id} f={f} onCrear={() => setCrearGasto(f)} onPagar={() => pagarFacturas(f)} onAnular={() => anular(f)} />)];
                })}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={subMuted}>
        Datos reales, cruzados con el mismo motor probado. Cada acción escribe en el sistema: crear gasto, marcar factura pagada y anular impactan tu EERR y tu Caja.
      </div>

      {crearGasto && (
        <CrearGastoModal fila={crearGasto} lid={lid} mesTxt={mesTxt}
          onClose={() => setCrearGasto(null)}
          onDone={() => { setCrearGasto(null); setVersion((v) => v + 1); }} />
      )}
    </div>
  );
}

function ConcFila({ f, onCrear, onPagar, onAnular }: { f: FilaConc; onCrear: () => void; onPagar: () => void; onAnular: () => void }) {
  const acc: { label: string; fn: () => void }[] = [];
  if (f.estado === "falta") {
    if (f.raw?.facturas?.length) acc.push({ label: `Marcar ${f.raw.facturas.length} comprobante(s) pagado(s)`, fn: onPagar });
    acc.push({ label: "Crear gasto", fn: onCrear });
  } else if (f.estado === "sobra") {
    acc.push({ label: "Anular", fn: onAnular });
  }
  return (
    <tr style={{ borderTop: "0.5px solid var(--pase-border)" }}>
      <td style={{ ...tdCell, color: "var(--pase-text-muted)", whiteSpace: "nowrap" }}>{f.fecha}</td>
      <td style={{ ...tdCell, maxWidth: 340 }}>
        <div style={f.tachado ? { textDecoration: "line-through", color: "var(--pase-text-muted)" } : undefined}>{f.concepto}</div>
        {(f.sub || acc.length > 0) && (
          <div style={{ marginTop: 3, fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", lineHeight: 1.5 }}>
            {f.sub && <span>{f.sub}{acc.length ? " · " : ""}</span>}
            {acc.map((a, i) => (
              <span key={i}>
                <button style={concLink} onClick={a.fn}>{a.label}</button>
                {i < acc.length - 1 && <span style={{ color: "var(--pase-border-strong)", margin: "0 5px" }}>·</span>}
              </span>
            ))}
          </div>
        )}
      </td>
      <td style={tdCell}>
        {f.categoria
          ? <select value={f.categoria} onChange={() => {}}
              style={{ ...selStyle, padding: "2px 6px", fontSize: "var(--pase-fs-xs)", ...(f.categoriaVacia ? { borderColor: "#B91C1C", color: "#B91C1C" } : {}) }}>
              <option value={f.categoria}>{f.categoria}</option>
            </select>
          : <span style={{ fontSize: "var(--pase-fs-xs)", fontWeight: 500, color: EST_TXT_COLOR[f.estado] }}>{f.estadoLabel}</span>}
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

/** Crear un gasto real (crear_gasto → EERR + Caja) desde una fila del extracto. */
function CrearGastoModal({ fila, lid, mesTxt, onClose, onDone }: {
  fila: FilaConc; lid: number; mesTxt: string; onClose: () => void; onDone: () => void;
}) {
  const cats = useCategorias();
  const [tipo, setTipo] = useState("");
  const [cat, setCat] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const TIPOS = ["Mercadería (CMV)", "Gasto Fijo", "Gasto Variable", "Publicidad", "Comisión", "Impuesto", "Otros"];
  const catsDisp =
    tipo === "Mercadería (CMV)" ? cats.CATEGORIAS_COMPRA
      : tipo === "Gasto Fijo" ? cats.GASTOS_FIJOS
        : tipo === "Gasto Variable" ? cats.GASTOS_VARIABLES
          : tipo === "Publicidad" ? cats.GASTOS_PUBLICIDAD
            : tipo === "Comisión" ? cats.COMISIONES_CATS
              : tipo === "Impuesto" ? cats.GASTOS_IMPUESTOS
                : tipo === "Otros" ? ["OTROS"] : [];
  const monto = Math.abs(fila.raw?.monto ?? 0);

  async function crear() {
    if (!tipo) { setErr("Elegí un tipo"); return; }
    if (!cat) { setErr("Elegí una categoría"); return; }
    if (!fila.raw) return;
    setSaving(true); setErr(null);
    const detalle = `[Concil. ${mesTxt}] ${fila.raw.descripcion}`;
    const { error } = await db.rpc("crear_gasto", {
      p_fecha: fila.raw.fecha, p_local_id: lid, p_categoria: cat, p_tipo: tipo,
      p_monto: monto, p_detalle: detalle, p_cuenta: "MercadoPago",
      p_plantilla_id: null, p_idempotency_key: crypto.randomUUID(),
    });
    if (error) { setErr(translateRpcError(error.message)); setSaving(false); return; }
    void db.rpc("fn_aprender_gasto_alias", { p_local_id: lid, p_descripcion: fila.raw.descripcion, p_categoria: cat, p_tipo: tipo });
    setSaving(false); onDone();
  }

  return (
    <Modal isOpen onClose={onClose} title="Crear gasto" subtitle={`${mesTxt} · MercadoPago`} preventCloseOnOverlay
      footer={<>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn btn-acc" disabled={saving} onClick={crear}>{saving ? "Creando…" : "Crear gasto"}</button>
      </>}>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
          {fila.concepto} · <b style={{ color: "var(--pase-text)" }}>{fmt_$(monto)}</b> · {fila.fecha}
        </div>
        <label style={{ display: "grid", gap: 4 }}><span style={subMuted}>Tipo</span>
          <select value={tipo} onChange={(e) => { setTipo(e.target.value); setCat(""); }} style={selStyle}>
            <option value="">Elegí…</option>{TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}><span style={subMuted}>Categoría</span>
          <select value={cat} onChange={(e) => setCat(e.target.value)} style={selStyle}>
            <option value="">{tipo ? "Elegí…" : "(elegí el tipo primero)"}</option>
            {catsDisp.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {err && <div style={{ color: "#B91C1C", fontSize: "var(--pase-fs-sm)" }}>{err}</div>}
      </div>
    </Modal>
  );
}

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
