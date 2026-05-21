// Panel de "Conexión Instagram" — se muestra arriba de Mensajería.
//
// 3 estados visuales:
//   - Sin config → pantalla grande "Conectá tu Instagram en 1 click"
//   - Conectada OK → mini-card con estado + días para vencer
//   - Por vencer / vencida → alerta amarilla/roja con botón "Renovar"
//
// El flow OAuth funciona así:
//   1. Click "Conectar" → RPC fn_ig_oauth_iniciar() devuelve state
//   2. Abrimos popup con la URL de autorización de Instagram + ese state
//   3. User autoriza → Instagram redirige al bot /api/oauth-callback
//   4. Bot procesa y redirige a PASE con ?ig_oauth=success
//   5. Esta pantalla detecta el query param + recarga

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { db } from "../../lib/supabase";

// ID público de la app de Instagram (no es secret — sale en URLs)
// Configurable por env por si en el futuro hay multiples apps por entorno.
const IG_APP_ID = import.meta.env.VITE_IG_APP_ID || "28110839805172593";

// URL del callback (debe coincidir con OAUTH_REDIRECT_URI configurado en el bot)
const OAUTH_REDIRECT_URI = import.meta.env.VITE_IG_OAUTH_REDIRECT
  || "https://pase-instagram-bot.vercel.app/api/oauth-callback";

// Scopes que pedimos a Instagram
const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
].join(",");

interface EstadoConexion {
  ig_account_id: string;
  ig_username: string | null;
  bot_activo: boolean;
  conectado_at: string;
  desconectado_at: string | null;
  token_creado_at: string | null;
  token_expira_at: string | null;
  connected_by_nombre: string | null;
  dias_para_vencer: number | null;
  estado: 'conectada' | 'desconectada' | 'vencida' | 'por_vencer' | 'desconocido';
}

export function IGConexionPanel() {
  const [params, setParams] = useSearchParams();
  const [conexion, setConexion] = useState<EstadoConexion | null>(null);
  const [loading, setLoading] = useState(true);
  const [conectando, setConectando] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    const { data } = await db.from('v_ig_conexion_estado').select('*').limit(1).single();
    setConexion(data as EstadoConexion | null);
    setLoading(false);
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  // Procesar el callback de OAuth que llega via query params
  useEffect(() => {
    const oauthStatus = params.get('ig_oauth');
    if (!oauthStatus) return;

    if (oauthStatus === 'success') {
      const username = params.get('username');
      setFlash({ kind: 'ok', msg: `✅ Conectado a @${username}. El bot ya está atendiendo.` });
      void cargar();
    } else {
      const errCode = params.get('error');
      const errDetail = params.get('detail');
      setFlash({ kind: 'err', msg: `❌ Error al conectar: ${errCode}${errDetail ? ` — ${errDetail}` : ''}` });
    }

    // Limpiar query params para que no aparezca el banner al refrescar
    params.delete('ig_oauth');
    params.delete('username');
    params.delete('error');
    params.delete('detail');
    params.delete('account_id');
    params.delete('expires_in_days');
    params.delete('ok');
    setParams(params, { replace: true });

    // Auto-dismiss del banner en 8s
    const t = setTimeout(() => setFlash(null), 8000);
    return () => clearTimeout(t);
  }, [params, setParams, cargar]);

  const iniciarOAuth = async () => {
    setConectando(true);
    try {
      // 1. Generar state via RPC
      const returnUrl = window.location.href.split('?')[0];
      const { data, error } = await db.rpc('fn_ig_oauth_iniciar', { p_return_url: returnUrl });
      if (error || !data || data.length === 0) {
        alert('Error al iniciar conexión: ' + (error?.message || 'sin state'));
        setConectando(false);
        return;
      }
      const state = (data as Array<{ state: string }>)[0]!.state;

      // 2. Armar URL de autorización de Instagram + redirigir el browser
      //
      // IMPORTANTE: construir la URL manualmente sin URLSearchParams.
      // Meta es estricto con el redirect_uri — exige que coincida EXACTO
      // entre la URL de autorización y el body del POST de exchange.
      // URLSearchParams.set codifica el redirect_uri (https:// → https%3A%2F%2F)
      // pero Meta lo compara con el redirect_uri del backend SIN decodificar,
      // así que si codifica uno y no el otro, falla con SHORT_TOKEN_FAILED.
      // La URL de inserción que Meta sugiere usa el redirect_uri SIN codificar,
      // así que replicamos eso.
      const authParams = [
        `client_id=${IG_APP_ID}`,
        `redirect_uri=${OAUTH_REDIRECT_URI}`,  // sin encode
        `scope=${SCOPES}`,
        `response_type=code`,
        `state=${state}`,
      ].join('&');
      const authUrl = `https://www.instagram.com/oauth/authorize?${authParams}`;

      // DEBUG: mostrar la URL antes de redirigir para verificar encoding
      console.log('[ig-oauth] authUrl:', authUrl);
      const ok = window.confirm(
        `Voy a abrir Instagram con esta URL:\n\n${authUrl}\n\n` +
        `Verificá que el redirect_uri NO esté codificado (debe decir "https://" sin %3A%2F%2F).\n\n` +
        `Click OK para continuar, Cancelar para detener.`,
      );
      if (!ok) {
        setConectando(false);
        return;
      }

      // Redirigimos top-window (no popup) porque Meta a veces bloquea popups
      window.location.href = authUrl;
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : String(e)));
      setConectando(false);
    }
  };

  const desconectar = async () => {
    if (!conexion) return;
    if (!confirm('¿Desconectar Instagram? El bot va a dejar de responder los DMs. Lo podés volver a conectar después.')) return;
    await db.from('ig_config').update({
      bot_activo: false,
      desconectado_at: new Date().toISOString(),
    }).eq('ig_account_id', conexion.ig_account_id);
    await cargar();
  };

  if (loading) return null;

  // ─── Banner de feedback post-OAuth ───
  const flashBanner = flash && (
    <div style={{
      padding: "12px 16px",
      borderRadius: 8,
      marginBottom: 12,
      background: flash.kind === 'ok' ? 'rgba(34,197,94,0.1)' : 'rgba(220,38,38,0.1)',
      border: `1px solid ${flash.kind === 'ok' ? 'rgba(34,197,94,0.3)' : 'rgba(220,38,38,0.3)'}`,
      color: flash.kind === 'ok' ? 'var(--success)' : 'var(--danger)',
      fontSize: 13,
      fontWeight: 500,
    }}>{flash.msg}</div>
  );

  // ─── Caso 1: sin conexión ───
  if (!conexion || conexion.estado === 'desconectada') {
    return (
      <>
        {flashBanner}
        <div style={{
          padding: "20px 24px",
          background: "linear-gradient(135deg, rgba(225,48,108,0.06), rgba(193,53,132,0.04))",
          border: "1px solid rgba(225,48,108,0.2)",
          borderRadius: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>
              📷 Conectá tu Instagram
            </div>
            <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.5 }}>
              El bot va a atender los DMs de tu cuenta de Instagram Business automáticamente,
              con memoria total + integrado al menú/horarios/reservas. Onboarding en 1 click.
            </div>
          </div>
          <button
            className="btn btn-acc"
            onClick={iniciarOAuth}
            disabled={conectando}
            style={{ padding: "10px 20px", fontSize: 14 }}
          >
            {conectando ? "Conectando..." : "📷 Conectar Instagram"}
          </button>
        </div>
      </>
    );
  }

  // ─── Caso 2: conexión vencida ───
  if (conexion.estado === 'vencida') {
    return (
      <>
        {flashBanner}
        <div style={{
          padding: "14px 18px",
          background: "rgba(220,38,38,0.08)",
          border: "1px solid rgba(220,38,38,0.3)",
          borderRadius: 8,
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: "var(--danger)" }}>
              ⚠ Conexión vencida con @{conexion.ig_username}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 2 }}>
              El token expiró. El bot dejó de responder. Reconectá para volver a operar.
            </div>
          </div>
          <button className="btn btn-acc" onClick={iniciarOAuth} disabled={conectando}>
            🔄 Reconectar
          </button>
        </div>
      </>
    );
  }

  // ─── Caso 3: por vencer ───
  if (conexion.estado === 'por_vencer') {
    return (
      <>
        {flashBanner}
        <div style={{
          padding: "12px 18px",
          background: "rgba(245,158,11,0.08)",
          border: "1px solid rgba(245,158,11,0.3)",
          borderRadius: 8,
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <div>
            <div style={{ fontWeight: 500, fontSize: 13 }}>
              ⚠ Conexión vence en {conexion.dias_para_vencer} día{conexion.dias_para_vencer !== 1 ? 's' : ''}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted2)" }}>
              @{conexion.ig_username} · se renueva automáticamente, pero podés forzarlo
            </div>
          </div>
          <button className="btn btn-sec btn-sm" onClick={iniciarOAuth} disabled={conectando}>
            Renovar ahora
          </button>
        </div>
      </>
    );
  }

  // ─── Caso 4: conexión OK ───
  return (
    <>
      {flashBanner}
      <div style={{
        padding: "10px 14px",
        background: "var(--s2)",
        border: "1px solid var(--bd)",
        borderRadius: 8,
        marginBottom: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--success)", fontSize: 14 }}>●</span>
          <span>
            <strong>@{conexion.ig_username}</strong>
            <span style={{ color: "var(--muted2)" }}> · conectada · renueva en {conexion.dias_para_vencer}d</span>
          </span>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={desconectar}
          title="Desconectar la cuenta de Instagram"
        >
          Desconectar
        </button>
      </div>
    </>
  );
}
