// Panel de "Conexión Instagram" — lista de cuentas conectadas (multi-cuenta).
//
// Comportamiento:
//   - Muestra una tabla/lista de todas las cuentas IG activas del tenant.
//   - Botón "+ Conectar otra cuenta" arriba.
//     · Si el tenant tiene >1 local → abre modal para elegir local destino.
//     · Si tiene 1 local → salta el modal y pasa el local directo.
//   - "Desconectar" sobre una cuenta específica: soft-delete solo de esa fila.
//   - Si no hay ninguna cuenta → pantalla grande de onboarding (backward compat).
//
// El flow OAuth funciona así:
//   1. Click "Conectar" → RPC fn_ig_oauth_iniciar(p_return_url, p_local_id) devuelve state
//   2. Redirigimos a la URL de autorización de Instagram con ese state
//   3. User autoriza → Instagram redirige al bot /api/oauth-callback
//   4. Bot procesa y redirige a PASE con ?ig_oauth=success
//   5. Esta pantalla detecta el query param + recarga

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { db } from "../../lib/supabase";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";
import type { Local } from "../../types";

const IG_APP_ID = import.meta.env.VITE_IG_APP_ID || "28110839805172593";

const OAUTH_REDIRECT_URI = import.meta.env.VITE_IG_OAUTH_REDIRECT
  || "https://pase-instagram-bot.vercel.app/api/oauth-callback";

const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
].join(",");

const BOT_API_URL = (import.meta.env.VITE_IG_BOT_URL as string | undefined)
  || "https://pase-instagram-bot.vercel.app";

interface CuentaIG {
  id: number;
  ig_account_id: string;
  ig_username: string | null;
  local_id: number | null;
  bot_activo: boolean;
  token_expira_at: string | null;
  // Supabase devuelve el join one-to-many como array; tomamos [0] para el nombre.
  locales: { id: number; nombre: string }[] | null;
}

function diasParaVencer(tokenExpiresAt: string | null): number | null {
  if (!tokenExpiresAt) return null;
  const diff = new Date(tokenExpiresAt).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// ── Modal selector de local ────────────────────────────────────────────────
interface ModalLocalProps {
  locales: Local[];
  onConfirm: (localId: number | null) => void;
  onCancel: () => void;
}

function ModalElegirLocal({ locales, onConfirm, onCancel }: ModalLocalProps) {
  const [sel, setSel] = useState<string>("null");
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "var(--bg)", border: "1px solid var(--bd)",
        borderRadius: 12, padding: "24px 28px", width: 340, maxWidth: "90vw",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
      }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>
          Conectar cuenta IG
        </div>
        <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 16, lineHeight: 1.5 }}>
          Asocia esta cuenta a un local, o elegí "Todos los locales" si va a manejar todo el tenant.
        </div>
        <select
          value={sel}
          onChange={e => setSel(e.target.value)}
          style={{
            width: "100%", padding: "8px 10px", borderRadius: 6,
            border: "1px solid var(--bd)", background: "var(--s2)",
            fontSize: 13, marginBottom: 20, fontFamily: "inherit",
          }}
        >
          <option value="null">Todos los locales (cuenta global)</option>
          {locales.map(l => (
            <option key={l.id} value={String(l.id)}>{l.nombre}</option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onCancel}>Cancelar</button>
          <button
            className="btn btn-acc"
            onClick={() => onConfirm(sel === "null" ? null : Number(sel))}
          >
            Continuar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Componente principal ────────────────────────────────────────────────────
export function IGConexionPanel() {
  const [params, setParams] = useSearchParams();
  const [cuentas, setCuentas] = useState<CuentaIG[]>([]);
  const [locales, setLocales] = useState<Local[]>([]);
  const [loading, setLoading] = useState(true);
  const [conectando, setConectando] = useState(false);
  const [modalLocalOpen, setModalLocalOpen] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [logs, setLogs] = useState<Array<{ tipo: string; error_message: string | null; payload: unknown; created_at: string }>>([]);
  const { toast, showToast, showError } = useToast();

  // Ref para permitir recursión interna en cargar() sin disparar el lint
  // "Cannot access variable before declared" (cargar se referencia a sí mismo
  // en el setTimeout del fallback de sin-sesión).
  const cargarRef = useRef<(() => Promise<void>) | null>(null);
  const cargar = useCallback(async () => {
    setLoading(true);
    // Fix 2026-05-30 v2 (CAUSA RAÍZ del "Conecta tu Instagram" falso al
    // recargar): es un RACE CONDITION. Al recargar la página, este useEffect
    // dispara la query a ig_config ANTES de que el cliente de Supabase termine
    // de hidratar la sesión desde localStorage. Sin sesión, la query corre como
    // anónima → la RLS (tenant_id = auth_tenant_id()) devuelve 0 filas SIN
    // error → cuentas=[] → onboarding engañoso. Por eso era intermitente.
    //
    // getSession() resuelve recién cuando el cliente auth terminó de
    // inicializar. Esperarlo acá garantiza que la query lleve el token y
    // RLS resuelva con el tenant correcto. Si tras esperar NO hay sesión,
    // es un estado inválido (no debería pasar dentro de Mensajería) → no
    // mostramos el empty state; dejamos loading y salimos para reintentar.
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      // eslint-disable-next-line no-console
      console.warn('[IGConexionPanel] sin sesión al cargar, reintento en 400ms');
      setTimeout(() => { void cargarRef.current?.(); }, 400);
      return;
    }
    const [cuentasResp, localesResp] = await Promise.all([
      db.from('ig_config')
        .select('id, ig_account_id, ig_username, local_id, bot_activo, token_expira_at, locales(id, nombre)')
        .is('desconectado_at', null)
        .order('id'),
      db.from('locales').select('id, nombre').order('nombre'),
    ]);

    let cuentasData = cuentasResp.data as CuentaIG[] | null;
    if (cuentasResp.error) {
      // eslint-disable-next-line no-console
      console.warn('[IGConexionPanel] error cargando ig_config con join, reintento sin join:', cuentasResp.error);
      // Reintentar sin el join a `locales` — capaz hay un RLS gate ahí.
      const r2 = await db.from('ig_config')
        .select('id, ig_account_id, ig_username, local_id, bot_activo, token_expira_at')
        .is('desconectado_at', null)
        .order('id');
      if (r2.error) {
        // eslint-disable-next-line no-console
        console.error('[IGConexionPanel] ig_config inalcanzable incluso sin join:', r2.error);
        showError('No pudimos cargar las cuentas IG. Recargá la página.');
      } else {
        cuentasData = (r2.data || []).map(c => ({ ...c, locales: null })) as CuentaIG[];
      }
    }
    if (localesResp.error) {
      // eslint-disable-next-line no-console
      console.warn('[IGConexionPanel] error cargando locales:', localesResp.error);
    }
    setCuentas(cuentasData || []);
    setLocales((localesResp.data as Local[]) || []);
    setLoading(false);
  }, [showError]);

  useEffect(() => { cargarRef.current = cargar; void cargar(); }, [cargar]);

  // Procesar callback OAuth
  useEffect(() => {
    const oauthStatus = params.get('ig_oauth');
    if (!oauthStatus) return;

    if (oauthStatus === 'success') {
      const username = params.get('username');
      setFlash({ kind: 'ok', msg: `Conectado a @${username}. El bot ya esta atendiendo.` });
      void cargar();
    } else {
      const errCode = params.get('error');
      const errDetail = params.get('detail');
      setFlash({ kind: 'err', msg: `Error al conectar: ${errCode}${errDetail ? ` — ${errDetail}` : ''}` });
    }

    params.delete('ig_oauth');
    params.delete('username');
    params.delete('error');
    params.delete('detail');
    params.delete('account_id');
    params.delete('expires_in_days');
    params.delete('ok');
    setParams(params, { replace: true });

    const t = setTimeout(() => setFlash(null), 8000);
    return () => clearTimeout(t);
  }, [params, setParams, cargar]);

  // Ver últimos eventos del bot (OAuth debugs + errores). RLS limita a tenant
  // propio. Sirve para debuggear "por qué no me deja conectar @maneki" sin
  // tener que abrir Supabase Studio.
  const verUltimosErrores = async () => {
    const { data, error } = await db.from('ig_eventos')
      .select('tipo, error_message, payload, created_at')
      .in('tipo', ['error', 'oauth_debug', 'oauth_conectado', 'token_refresh_failed'])
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) { showError('No pude leer los logs: ' + error.message); return; }
    setLogs(data || []);
    setLogsModalOpen(true);
  };

  // Diagnóstico
  const runDiagnostic = async () => {
    const { data: { session } } = await db.auth.getSession();
    const token = session?.access_token;
    if (!token) { showError('Sesion expirada'); return; }
    try {
      const r = await fetch(`${BOT_API_URL}/api/diagnostic`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await r.json();
      if (!r.ok) { showError('Error: ' + (data.error || `HTTP ${r.status}`)); return; }
      const lines: string[] = ['Config bot:'];
      const rep = data.report;
      lines.push(`APP_ID: ${rep.IG_APP_ID}`);
      lines.push(`REDIRECT: ${rep.OAUTH_REDIRECT_URI}`);
      for (const [k, v] of Object.entries(rep)) {
        if (typeof v === 'object' && v !== null && 'set' in (v as object)) {
          const p = v as { set: boolean; length?: number; first4?: string; last4?: string };
          lines.push(`${k}: ${p.set ? `[${p.length}ch] ${p.first4}...${p.last4}` : '(NO SET)'}`);
        }
      }
      showToast(lines.join(' | '), 'info');
    } catch (e) {
      showError('Error: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Lanza el flow OAuth con el local elegido (null = global)
  const iniciarOAuth = async (localId: number | null) => {
    setConectando(true);
    try {
      const returnUrl = window.location.href.split('?')[0];
      const rpcArgs: Record<string, unknown> = { p_return_url: returnUrl };
      if (localId !== null) rpcArgs.p_local_id = localId;
      const { data, error } = await db.rpc('fn_ig_oauth_iniciar', rpcArgs);
      if (error || !data || (data as Array<{ state: string }>).length === 0) {
        showError('Error al iniciar conexion: ' + (error?.message || 'sin state'));
        setConectando(false);
        return;
      }
      const state = (data as Array<{ state: string }>)[0]!.state;
      const authUrl = new URL('https://www.instagram.com/oauth/authorize');
      authUrl.searchParams.set('client_id', IG_APP_ID);
      authUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
      authUrl.searchParams.set('scope', SCOPES);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', state);
      window.location.href = authUrl.toString();
    } catch (e) {
      showError('Error: ' + (e instanceof Error ? e.message : String(e)));
      setConectando(false);
    }
  };

  // Click en "+ Conectar otra cuenta"
  const handleConectar = () => {
    if (locales.length <= 1) {
      // 0 o 1 local: saltar modal
      void iniciarOAuth(locales[0]?.id ?? null);
    } else {
      setModalLocalOpen(true);
    }
  };

  // Desconectar UNA cuenta específica
  const desconectarCuenta = async (cuenta: CuentaIG) => {
    const label = cuenta.ig_username ? `@${cuenta.ig_username}` : cuenta.ig_account_id;
    if (!confirm(`¿Desconectar ${label}? El bot va a dejar de responder esos DMs. Podés volver a conectarla despues.`)) return;
    await db.from('ig_config')
      .update({ bot_activo: false, desconectado_at: new Date().toISOString() })
      .eq('id', cuenta.id);
    await cargar();
  };

  if (loading) return <ToastComponent toast={toast} />;

  // ─── Banner de feedback post-OAuth ───
  const flashBanner = flash && (
    <div style={{
      padding: "12px 16px", borderRadius: 8, marginBottom: 12,
      background: flash.kind === 'ok' ? 'rgba(34,197,94,0.1)' : 'rgba(220,38,38,0.1)',
      border: `1px solid ${flash.kind === 'ok' ? 'rgba(34,197,94,0.3)' : 'rgba(220,38,38,0.3)'}`,
      color: flash.kind === 'ok' ? 'var(--success)' : 'var(--danger)',
      fontSize: 13, fontWeight: 500,
    }}>{flash.msg}</div>
  );

  // ─── Sin ninguna cuenta: pantalla de onboarding (backward compat) ───
  if (cuentas.length === 0) {
    return (
      <>
        <ToastComponent toast={toast} />
        {flashBanner}
        <div style={{
          padding: "20px 24px",
          background: "linear-gradient(135deg, rgba(225,48,108,0.06), rgba(193,53,132,0.04))",
          border: "1px solid rgba(225,48,108,0.2)",
          borderRadius: 12, marginBottom: 16,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 16, flexWrap: "wrap",
        }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>
              Conecta tu Instagram
            </div>
            <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.5 }}>
              El bot va a atender los DMs de tu cuenta de Instagram Business automaticamente,
              con memoria total + integrado al menu/horarios/reservas. Onboarding en 1 click.
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
            <button
              className="btn btn-acc"
              onClick={handleConectar}
              disabled={conectando}
              style={{ padding: "10px 20px", fontSize: 14 }}
            >
              {conectando ? "Conectando..." : "Conectar Instagram"}
            </button>
            <button
              type="button" onClick={runDiagnostic}
              style={{ fontSize: 10, color: "var(--muted2)", background: "transparent", border: "none", cursor: "pointer", textDecoration: "underline" }}
            >
              Verificar configuracion del bot
            </button>
            <button
              type="button" onClick={verUltimosErrores}
              style={{ fontSize: 10, color: "var(--muted2)", background: "transparent", border: "none", cursor: "pointer", textDecoration: "underline" }}
            >
              Ver ultimos errores
            </button>
          </div>
        </div>
        {modalLocalOpen && (
          <ModalElegirLocal
            locales={locales}
            onConfirm={localId => { setModalLocalOpen(false); void iniciarOAuth(localId); }}
            onCancel={() => { setModalLocalOpen(false); setConectando(false); }}
          />
        )}
        {logsModalOpen && <LogsModal logs={logs} onClose={() => setLogsModalOpen(false)} />}
      </>
    );
  }

  // ─── Lista de cuentas conectadas ───
  return (
    <>
      <ToastComponent toast={toast} />
      {flashBanner}
      <div style={{
        border: "1px solid var(--bd)", borderRadius: 10,
        marginBottom: 16, overflow: "hidden",
      }}>
        {/* Header con botón Conectar */}
        <div style={{
          padding: "10px 14px", borderBottom: "1px solid var(--bd)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--s2)",
        }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            Cuentas de Instagram conectadas ({cuentas.length})
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button" onClick={runDiagnostic}
              style={{ fontSize: 10, color: "var(--muted2)", background: "transparent", border: "none", cursor: "pointer", textDecoration: "underline" }}
            >
              Verificar bot
            </button>
            <button
              type="button" onClick={verUltimosErrores}
              style={{ fontSize: 10, color: "var(--muted2)", background: "transparent", border: "none", cursor: "pointer", textDecoration: "underline" }}
            >
              Ver ultimos errores
            </button>
            <button
              className="btn btn-acc btn-sm"
              onClick={handleConectar}
              disabled={conectando}
              style={{ fontSize: 12 }}
            >
              {conectando ? "Conectando..." : "+ Conectar otra cuenta"}
            </button>
          </div>
        </div>

        {/* Filas por cuenta */}
        {cuentas.map((cuenta, idx) => {
          const dias = diasParaVencer(cuenta.token_expira_at);
          const vencida = dias !== null && dias <= 0;
          const porVencer = dias !== null && dias > 0 && dias <= 7;
          const localNombre = cuenta.locales?.[0]?.nombre ?? null;

          return (
            <div key={cuenta.id} style={{
              padding: "10px 14px",
              borderBottom: idx < cuentas.length - 1 ? "1px solid var(--bd)" : undefined,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 12, flexWrap: "wrap",
            }}>
              {/* Identidad */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                <span style={{
                  color: vencida ? "var(--danger)" : cuenta.bot_activo ? "var(--success)" : "var(--muted2)",
                  fontSize: 14, flexShrink: 0,
                }}>
                  {vencida ? "!" : "●"}
                </span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    @{cuenta.ig_username ?? cuenta.ig_account_id}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                    {localNombre ?? "Todos los locales"}
                    {dias !== null && (
                      <span style={{ marginLeft: 8, color: vencida ? "var(--danger)" : porVencer ? "var(--warn)" : "var(--muted)" }}>
                        · {vencida ? "token vencido" : `renueva en ${dias}d`}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Badges de estado */}
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                {vencida && (
                  <span className="badge b-danger" style={{ fontSize: 10 }}>Vencida</span>
                )}
                {porVencer && !vencida && (
                  <span className="badge b-warn" style={{ fontSize: 10 }}>Por vencer</span>
                )}
                {!vencida && cuenta.bot_activo && (
                  <span className="badge b-success" style={{ fontSize: 10 }}>Activa</span>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => desconectarCuenta(cuenta)}
                  style={{ fontSize: 11 }}
                >
                  Desconectar
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal selector de local */}
      {modalLocalOpen && (
        <ModalElegirLocal
          locales={locales}
          onConfirm={localId => { setModalLocalOpen(false); void iniciarOAuth(localId); }}
          onCancel={() => { setModalLocalOpen(false); setConectando(false); }}
        />
      )}

      {/* Modal últimos errores Meta — diagnóstico de OAuth y refresh */}
      {logsModalOpen && <LogsModal logs={logs} onClose={() => setLogsModalOpen(false)} />}
    </>
  );
}

// ── Modal: lista de últimos eventos del bot IG ──────────────────────────────
// Muestra logs de ig_eventos en formato legible. Útil para diagnosticar:
//   - Por qué falla OAuth (errores de Meta tipo LONG_TOKEN_FAILED)
//   - Por qué el refresh diario falla
//   - Si una cuenta nueva (ej @maneki) no tiene permisos en la app de Meta
interface LogEntry {
  tipo: string;
  error_message: string | null;
  payload: unknown;
  created_at: string;
}

function LogsModal({ logs, onClose }: { logs: LogEntry[]; onClose: () => void }) {
  const colorPorTipo = (t: string) => {
    if (t === 'error' || t.includes('failed')) return 'var(--danger)';
    if (t === 'oauth_conectado') return 'var(--success)';
    return 'var(--muted2)';
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        background: 'var(--bg)', border: '1px solid var(--bd)',
        borderRadius: 12, width: 720, maxWidth: '95vw', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid var(--bd)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Últimos eventos del bot IG</div>
            <div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 2 }}>
              {logs.length} eventos · solo los últimos 20 (debug, errores, conexiones)
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cerrar</button>
        </div>
        <div style={{ overflow: 'auto', padding: '8px 14px', flex: 1 }}>
          {logs.length === 0 ? (
            <div style={{ color: 'var(--muted2)', fontSize: 13, padding: '20px 4px', textAlign: 'center' }}>
              No hay eventos registrados todavía.
            </div>
          ) : logs.map((log, i) => (
            <div key={i} style={{
              padding: '10px 12px',
              borderBottom: i < logs.length - 1 ? '1px solid var(--bd)' : undefined,
              fontSize: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ color: colorPorTipo(log.tipo), fontWeight: 600 }}>
                  {log.tipo}
                </span>
                <span style={{ color: 'var(--muted2)', fontSize: 11 }}>
                  {new Date(log.created_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'medium' })}
                </span>
              </div>
              {log.error_message && (
                <div style={{
                  fontFamily: 'monospace', fontSize: 11, color: 'var(--danger)',
                  background: 'rgba(220,38,38,0.06)', padding: '6px 8px', borderRadius: 4,
                  marginBottom: 4, wordBreak: 'break-word',
                }}>
                  {log.error_message}
                </div>
              )}
              {log.payload !== null && log.payload !== undefined && (
                <details style={{ fontSize: 11, color: 'var(--muted2)' }}>
                  <summary style={{ cursor: 'pointer', userSelect: 'none' }}>payload</summary>
                  <pre style={{
                    fontFamily: 'monospace', fontSize: 10,
                    background: 'var(--s2)', padding: '6px 8px', borderRadius: 4,
                    marginTop: 4, overflow: 'auto', maxHeight: 200,
                  }}>{JSON.stringify(log.payload, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
