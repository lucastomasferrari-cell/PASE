import { useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { fmt_d, fmt_$, genId, toISO } from "../lib/utils";
import { useMediosCobro } from "../lib/useMediosCobro";
import { parseCierre, PARSER_VERSION, type ParseError, type ParsedCierre } from "../lib/maxirest/parser";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

interface ImportarMaxirestProps {
  // Compat con App.tsx (no se usa pero se acepta para no romper).
  locales?: unknown;
  localActivo?: number | null;
  onImported?: () => void;
  /** Cuando true, omite el ph-row con título 'Importar Maxirest'. Usado
   * cuando el componente se renderiza dentro de un <Modal/> que ya
   * dibuja su propio header. Sprint mayo 2026 v2 bug fix. */
  embedded?: boolean;
}

interface MedioMapeado {
  raw: string;
  /** Nombre del medio en el catálogo del local (null si no matchea). */
  matched: string | null;
  monto: number;
  cantidad: number;
}

type Bloqueo =
  | { tipo: 'sin_local' }
  | { tipo: 'medio_no_configurado'; nombre: string };

export default function ImportarMaxirest({ localActivo, onImported, embedded = false }: ImportarMaxirestProps) {
  const [texto, setTexto] = useState('');
  const [parsed, setParsed] = useState<ParsedCierre | null>(null);
  const [errores, setErrores] = useState<ParseError[]>([]);
  const [loading, setLoading] = useState(false);
  const { mediosDisponibles } = useMediosCobro();
  const { toast, showToast, showError } = useToast();

  function procesar() {
    if (!texto.trim()) return;
    const r = parseCierre(texto);
    if (r.ok) { setParsed(r.data); setErrores([]); }
    else { setParsed(null); setErrores(r.errores); }
  }

  function reset() { setParsed(null); setErrores([]); setTexto(''); }

  // Mapeo medios → catálogo del local activo (case-insensitive exacto).
  const medios: MedioMapeado[] = useMemo(() => {
    if (!parsed || localActivo == null) return [];
    const cat = mediosDisponibles(Number(localActivo));
    return parsed.medios.map(m => {
      const target = m.nombre.trim().toUpperCase();
      const found = cat.find(c => c.nombre.trim().toUpperCase() === target);
      return { raw: m.nombre, matched: found?.nombre ?? null, monto: m.monto, cantidad: m.cantidad };
    });
  }, [parsed, localActivo, mediosDisponibles]);

  const totalCierre = medios.reduce((s, m) => s + m.monto, 0);

  const bloqueo: Bloqueo | null = useMemo(() => {
    if (!parsed) return null;
    if (localActivo == null) return { tipo: 'sin_local' };
    const sinConfig = medios.find(m => !m.matched);
    if (sinConfig) return { tipo: 'medio_no_configurado', nombre: sinConfig.raw };
    return null;
  }, [parsed, medios, localActivo]);

  async function importar() {
    if (!parsed || localActivo == null || bloqueo) return;
    setLoading(true);
    try {
      const lid = Number(localActivo);
      const fechaIso = toISO(parsed.fecha);
      // El schema histórico usa "Mediodía" / "Noche" (con tilde y mayúscula).
      const turnoDB = parsed.turno === 'noche' ? 'Noche' : 'Mediodía';

      // Bloqueo de duplicados (2026-05-13): permitir cargar 2 cierres del
      // mismo (local, fecha, turno) generaba ventas duplicadas + movs
      // duplicados en caja chica. Caso real: Rene Cantina 12/05 noche
      // se importó 2 veces con 42min de diferencia → $315.900 extra en
      // caja chica. Antes el sistema mostraba un confirm() que permitía
      // "Importar igual" y eso era exactamente lo que causaba el bug.
      //
      // Ahora bloquea con alert sin opción de continuar. Si el cierre
      // previo está mal, primero hay que eliminarlo desde Ventas (eso
      // borra las ventas y revierte los saldos via RPC eliminar_cierre).
      const { data: dup } = await db.from('ventas').select('id')
        .eq('fecha', fechaIso).eq('turno', turnoDB).eq('local_id', lid).limit(1);
      if (dup && dup.length > 0) {
        showError(
          `Ya existe un cierre del ${fmt_d(fechaIso)} turno ${turnoDB} para este local. ` +
          `Si el cierre anterior está mal y querés reemplazarlo, primero eliminalo desde Ventas y volvé a importar.`,
        );
        setLoading(false);
        return;
      }

      const ventas = medios.map(m => ({
        id: genId('V'),
        medio: m.matched!,        // bloqueo previene null
        monto: m.monto,
        cant: m.cantidad,
        fecha: fechaIso,
        turno: turnoDB,
        local_id: lid,
        origen: 'maxirest',
        parser_version: PARSER_VERSION,
      }));
      // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F13: importador batch debe ir por RPC importar_maxirest_batch que en una transacción inserte ventas + movimientos + ajuste saldos. Hoy el rollback manual (línea ~171) deja saldos inflados si falla a mitad.
      const { data: ins, error } = await db.from('ventas').insert(ventas).select();
      if (error) throw new Error('INSERT ventas: ' + error.message);
      if (!ins || ins.length === 0) {
        throw new Error('Insert no devolvió filas — RLS bloqueando o permisos del local.');
      }
      const insertedIds = (ins as { id: string }[]).map(r => r.id);

      // Generar movimientos en caja por medio con cuenta_destino mapeada.
      //
      // CRÍTICO — fix bug 7-may: la versión anterior usaba el cache del
      // hook useMediosCobro (cuentaDestino()) para resolver cuenta_destino.
      // El cache podía estar en FALLBACK (constants.ts) que NO tiene
      // "EFECTIVO" pelado (solo EFECTIVO SALON/DELIVERY) → resolvía null
      // y se saltaban TODOS los movs sin error. Ahora consultamos
      // medios_cobro directo en BD para garantizar consistencia.
      //
      // ATÓMICO via RPC: usamos crear_movimiento_caja (la misma RPC que
      // usa Caja.tsx:guardar para nuevos movs manuales). La RPC hace
      // INSERT mov + UPSERT saldo en una transacción server-side con
      // ON CONFLICT DO UPDATE — race-safe contra doble click. Reemplaza
      // el SELECT-then-UPDATE viejo que tenía race condition.
      const mediosUsados = Array.from(new Set((ins as { medio: string }[]).map(r => r.medio)));
      const { data: catRows, error: catErr } = await db.from('medios_cobro')
        .select('nombre, local_id, cuenta_destino, activo')
        .in('nombre', mediosUsados)
        .or(`local_id.is.null,local_id.eq.${lid}`);
      if (catErr) throw new Error('SELECT medios_cobro: ' + catErr.message);
      // Resolver cuenta_destino por medio: prefiere local-specific sobre global,
      // ignora inactivos. Mismo criterio que pickCuentaDestino del hook.
      function resolverCuenta(medio: string): string | null {
        const candidatos = (catRows || []).filter(r => r.activo && r.nombre === medio);
        if (candidatos.length === 0) return null;
        const ganador = candidatos.find(r => r.local_id !== null) || candidatos[0];
        return ganador?.cuenta_destino ?? null;
      }

      const impactoPorCuenta: Record<string, number> = {};
      const idsPorCuenta: Record<string, string[]> = {};
      for (const v of ins as { id: string; medio: string; monto: number }[]) {
        const cuenta = resolverCuenta(v.medio);
        if (!cuenta) continue; // medios no-efectivo no impactan caja
        impactoPorCuenta[cuenta] = (impactoPorCuenta[cuenta] || 0) + Number(v.monto || 0);
        (idsPorCuenta[cuenta] = idsPorCuenta[cuenta] || []).push(v.id);
      }

      const movsCreados: string[] = [];
      try {
        for (const [cuenta, monto] of Object.entries(impactoPorCuenta)) {
          if (!cuenta) continue;
          // RPC server-side atómica: INSERT mov + UPSERT saldo en una sola
          // transacción. Race-safe (ON CONFLICT DO UPDATE saldo = saldo + delta).
          const { data: rpcData, error: rpcErr } = await db.rpc('crear_movimiento_caja', {
            p_fecha: fechaIso,
            p_cuenta: cuenta,
            p_tipo: 'Ingreso Venta',
            p_cat: 'VENTAS',
            p_importe: monto,
            p_detalle: `Ventas ${turnoDB} - ${fechaIso} (Maxirest)`,
            p_local_id: lid,
          });
          if (rpcErr) throw new Error('RPC crear_movimiento_caja[' + cuenta + ']: ' + rpcErr.message);
          const movId = (rpcData as { mov_id?: string } | null)?.mov_id;
          if (!movId) throw new Error('RPC crear_movimiento_caja[' + cuenta + '] no devolvió mov_id');
          movsCreados.push(movId);

          // Vincular el mov con sus ventas (la RPC no lo hace).
          // Necesario para que eliminar_cierre RPC pueda limpiar atómicamente.
          // Si falla solo el linkeo, el saldo ya se movió OK — solo loguear.
          const ventaIds = idsPorCuenta[cuenta] || [];
          if (ventaIds.length > 0) {
            // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F13: parte del importer batch (ver línea ~92).
            const { error: linkErr } = await db.from('movimientos')
              .update({ venta_ids: ventaIds }).eq('id', movId);
            if (linkErr) console.warn('No se pudo vincular venta_ids al mov ' + movId + ': ' + linkErr.message);
          }
        }
      } catch (movFail) {
        // Rollback: borrar ventas + movs ya creados para no dejar estado parcial.
        // El saldo de cada mov creado quedará "inflado" hasta que el usuario lo
        // anule manualmente (la RPC no expone un reverse atómico de saldo).
        // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F13: rollback manual del importer. La RPC pendiente lo haría con transacción.
        await db.from('ventas').delete().in('id', insertedIds);
        for (const movId of movsCreados) {
          // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F13: idem.
          await db.from('movimientos').delete().eq('id', movId);
        }
        throw movFail;
      }

      const cuentasImpactadas = Object.keys(impactoPorCuenta);
      const detalle = cuentasImpactadas.length > 0
        ? ' · Impacto caja: ' + cuentasImpactadas.map(c => c + ' ' + fmt_$(impactoPorCuenta[c]!)).join(', ')
        : ' · ⚠️ NO impactó caja (ningún medio tiene cuenta_destino mapeada)';
      showToast('Importado: ' + ins.length + ' filas · Total: ' + fmt_$(totalCierre) + detalle);
      reset();
      onImported?.();
    } catch (e: unknown) {
      showError('No se pudo importar: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {!embedded && (
        <div className="ph-row"><div><div className="ph-title">Importar Maxirest</div></div></div>
      )}

      {errores.length > 0 && <PanelErrores errores={errores} />}

      <div className="panel">
        <div className="panel-hd"><span className="panel-title">Texto del cierre</span></div>
        <div style={{ padding: 16 }}>
          <textarea
            style={{
              width: '100%', height: 280, background: 'var(--bg)', border: '1px solid var(--bd)',
              color: 'var(--txt)', padding: '10px 12px', fontFamily: "'DM Mono',monospace",
              fontSize: 11, borderRadius: 'var(--r)', outline: 'none', resize: 'vertical',
            }}
            placeholder="Pegá acá el texto completo del mail de cierre de Maxirest..."
            value={texto}
            onChange={e => setTexto(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-acc" onClick={procesar} disabled={!texto.trim()}>
              Procesar cierre
            </button>
            {(parsed || errores.length > 0) && (
              <button className="btn btn-sec" onClick={reset}>Limpiar</button>
            )}
          </div>
        </div>
      </div>

      {parsed && (
        <Preview
          parsed={parsed}
          medios={medios}
          totalCierre={totalCierre}
          bloqueo={bloqueo}
          loading={loading}
          onImportar={importar}
        />
      )}
      {toast && <ToastComponent toast={toast} />}
    </div>
  );
}

function PanelErrores({ errores }: { errores: ParseError[] }) {
  return (
    <div className="panel" style={{ borderColor: 'var(--danger)' }}>
      <div className="panel-hd" style={{ background: 'rgba(239,68,68,0.1)' }}>
        <span className="panel-title" style={{ color: 'var(--danger)' }}>
          ⚠️ No se pudo procesar el cierre
        </span>
      </div>
      <div style={{ padding: 16 }}>
        <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
          {errores.map((e, i) => (
            <li key={i} style={{ fontSize: 13 }}>{e.mensaje}</li>
          ))}
        </ul>
        <p style={{ fontSize: 12, color: 'var(--muted2)', marginTop: 12, marginBottom: 0 }}>
          Verificá el texto del cierre y volvé a procesar.
        </p>
      </div>
    </div>
  );
}

interface PreviewProps {
  parsed: ParsedCierre;
  medios: MedioMapeado[];
  totalCierre: number;
  bloqueo: Bloqueo | null;
  loading: boolean;
  onImportar: () => void;
}

function Preview({ parsed, medios, totalCierre, bloqueo, loading, onImportar }: PreviewProps) {
  if (bloqueo) return <BloqueoMsg bloqueo={bloqueo} />;
  const turnoLabel = parsed.turno === 'noche' ? 'Noche' : 'Mediodía';
  return (
    <div className="panel">
      <div className="panel-hd"><span className="panel-title">Cierre detectado</span></div>
      <div style={{ padding: 16, display: 'grid', gap: 12 }}>
        <Linea label="Fecha" valor={fmt_d(toISO(parsed.fecha))} />
        <Linea label="Turno" valor={turnoLabel} />
        <Linea label="Total" valor={fmt_$(totalCierre)} />

        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--muted2)', marginBottom: 6 }}>Medios de cobro:</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            {medios.map((m, i) => (
              <li key={i} style={{ fontSize: 13 }}>
                <span style={{ fontWeight: 500 }}>{m.matched ?? m.raw}</span>
                {' — '}
                <span className="num kpi-success">{fmt_$(m.monto)}</span>
                <span style={{ color: 'var(--muted2)', fontSize: 11 }}> ({m.cantidad})</span>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-acc" onClick={onImportar} disabled={loading}>
            {loading ? 'Importando…' : 'Importar al local'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Linea({ label, valor }: { label: string; valor: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'baseline' }}>
      <div style={{ fontSize: 12, color: 'var(--muted2)' }}>{label}:</div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{valor}</div>
    </div>
  );
}

function BloqueoMsg({ bloqueo }: { bloqueo: Bloqueo }) {
  const msg = bloqueo.tipo === 'sin_local'
    ? 'Tenés que tener un local activo seleccionado en el sidebar para importar.'
    : `El medio "${bloqueo.nombre}" no está configurado en el catálogo del local. Andá a Configuración → Medios de cobro, agregalo, y volvé a procesar el cierre.`;
  return (
    <div className="panel">
      <div className="panel-hd"><span className="panel-title">No se puede importar</span></div>
      <div style={{ padding: 16 }}>
        <div className="alert alert-warn" style={{ fontSize: 13, lineHeight: 1.6 }}>{msg}</div>
      </div>
    </div>
  );
}
