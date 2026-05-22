// Pantalla /ajustes/notificaciones — configurar qué notificaciones push
// recibe el user (en compu + celu).
//
// Funciona en compu y celu igual:
//   - Suscripción al PushManager via `lib/push.ts` (mismo flow que /mensajeria,
//     usa VAPID + service worker `public/sw.js`).
//   - Una vez suscripto, cualquier emisor (bot IG, cron de cierre, RPC de
//     marketplace, etc.) chequea `fn_user_quiere_notif(user_id, tipo)` antes
//     de mandar el push.
//   - Default: si el user NO tocó la pantalla → recibe todo (opt-out).
//
// La granularidad es PER USER, no PER DEVICE (decisión 22-may noche: simpler).
// Si Lucas tiene la compu suscripta + el celu suscripto, ambos reciben todos
// los tipos que tenga ON. Si desactiva `ig_dm_new` → no llega a ninguno.
//
// Lucas 22-may noche: "estaria bueno que podamos mandar mas notificaciones
// no solo estas, podriamos tener en configuracion una parte donde definimos
// que notificaciones queremos recibir"

import { useEffect, useState, useCallback, useMemo } from "react";
import { db } from "../lib/supabase";
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_GROUPS,
  type NotificationTypeId,
} from "../lib/notification-types";
import {
  getPushPermissionStatus,
  isCurrentlySubscribed,
  subscribeToPush,
  unsubscribeFromPush,
} from "../lib/push";
import type { Usuario } from "../types";

interface Props {
  user: Usuario;
}

interface PrefRow {
  notification_type: string;
  enabled: boolean;
}

export default function ConfiguracionNotificaciones({ user }: Props) {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [savingType, setSavingType] = useState<string | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const perm = getPushPermissionStatus();

  // ─── Carga inicial: preferences + estado de suscripción push ─────────
  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await db
      .from("notification_preferences")
      .select("notification_type, enabled")
      .eq("user_id", user.id);
    const map: Record<string, boolean> = {};
    // Default: si NO hay fila → enabled (opt-out). Inicializo TODOS los tipos
    // con true y después sobreescribo con lo que esté guardado.
    for (const t of NOTIFICATION_TYPES) map[t.id] = true;
    for (const row of (data as PrefRow[] | null) || []) {
      map[row.notification_type] = row.enabled;
    }
    setPrefs(map);
    setLoading(false);

    if (perm !== "unsupported") {
      setPushSubscribed(await isCurrentlySubscribed());
    }
  }, [user.id, perm]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- reload() es async y los setState están dentro de la promise, no en cascada.
  useEffect(() => { void reload(); }, [reload]);

  // ─── Toggle individual ───────────────────────────────────────────────
  const toggle = async (typeId: NotificationTypeId, value: boolean) => {
    setSavingType(typeId);
    // Optimistic update
    setPrefs(prev => ({ ...prev, [typeId]: value }));
    try {
      // Upsert (insert si no existe, update si existe).
      const { error } = await db
        .from("notification_preferences")
        .upsert(
          { user_id: user.id, notification_type: typeId, enabled: value },
          { onConflict: "user_id,notification_type" },
        );
      if (error) {
        // Rollback
        setPrefs(prev => ({ ...prev, [typeId]: !value }));
        alert(`No se pudo guardar: ${error.message}`);
      }
    } finally {
      setSavingType(null);
    }
  };

  // ─── Suscripción push global (compu/celu) ────────────────────────────
  const togglePush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    try {
      if (pushSubscribed) {
        const r = await unsubscribeFromPush();
        if (r.ok) {
          setPushMsg({ kind: "ok", text: "Notificaciones desactivadas en este dispositivo" });
        } else {
          setPushMsg({ kind: "err", text: r.error || "Error desactivando" });
        }
      } else {
        const r = await subscribeToPush();
        if (r.ok) {
          setPushMsg({ kind: "ok", text: "🔔 Notificaciones activadas en este dispositivo. Vas a recibir los tipos que tengas en ON." });
        } else {
          setPushMsg({ kind: "err", text: r.error || "Error activando" });
        }
      }
      setPushSubscribed(await isCurrentlySubscribed());
    } finally {
      setPushBusy(false);
      setTimeout(() => setPushMsg(null), 6000);
    }
  };

  // ─── Agrupar tipos por grupo visual ──────────────────────────────────
  const tiposPorGrupo = useMemo(() => {
    const map: Record<string, typeof NOTIFICATION_TYPES> = {};
    for (const g of NOTIFICATION_GROUPS) map[g.id] = [];
    for (const t of NOTIFICATION_TYPES) {
      const arr = map[t.group];
      if (arr) arr.push(t);
    }
    return map;
  }, []);

  if (loading) return <div className="loading" style={{ padding: 40 }}>Cargando…</div>;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 880, margin: "0 auto", fontFamily: "var(--pase-font)" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>
          Notificaciones
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted2)", marginTop: 6, lineHeight: 1.5 }}>
          Elegí qué notificaciones querés recibir en la computadora y en el celular.
          Funciona igual para ambos dispositivos — si tenés un tipo activado, te
          llega a todos los dispositivos donde hayas activado push.
        </p>
      </div>

      {/* ─── Bloque 1: Activar push en ESTE dispositivo ───────────────── */}
      <div style={{
        background: "var(--s2)", border: "1px solid var(--bd)", borderRadius: 10,
        padding: 16, marginBottom: 20,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
          Push en este dispositivo
        </div>
        <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 12px", lineHeight: 1.5 }}>
          Tenés que activar push una vez por dispositivo (compu, celu, tablet).
          Después las preferencias de abajo aplican a todos. {' '}
          <span style={{ color: "var(--muted2)", fontStyle: "italic" }}>
            En el celu, recordá tener PASE instalado como app (PWA) para que las
            notificaciones lleguen aunque tengas el browser cerrado.
          </span>
        </p>

        {perm === "unsupported" ? (
          <div style={{ fontSize: 12, color: "var(--warn)" }}>
            ℹ️ Tu navegador no soporta notificaciones push. Probá con Chrome, Firefox o Edge.
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>
              {pushSubscribed === null ? "Verificando…"
                : pushSubscribed ? "🔔 Activo en este dispositivo"
                : "🔕 Inactivo en este dispositivo"}
            </span>
            <button
              className={pushSubscribed ? "btn btn-ghost btn-sm" : "btn btn-acc btn-sm"}
              onClick={togglePush}
              disabled={pushBusy || perm === "denied"}
            >
              {pushBusy ? "…" : (pushSubscribed ? "Desactivar" : "Activar")}
            </button>
            {perm === "denied" && (
              <span style={{ fontSize: 11, color: "var(--warn)" }}>
                Permisos bloqueados en el navegador — habilitalos en Configuración del browser
              </span>
            )}
            {pushMsg && (
              <span style={{
                fontSize: 11, fontWeight: 500,
                color: pushMsg.kind === "ok" ? "var(--success)" : "var(--danger)",
              }}>
                {pushMsg.text}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ─── Bloque 2: Tipos de notificación agrupados ────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {NOTIFICATION_GROUPS.map(grupo => {
          const tipos = tiposPorGrupo[grupo.id] || [];
          if (tipos.length === 0) return null;
          return (
            <div key={grupo.id} style={{
              background: "var(--s2)", border: "1px solid var(--bd)", borderRadius: 10,
              overflow: "hidden",
            }}>
              <div style={{
                padding: "12px 16px", borderBottom: "1px solid var(--bd)",
                fontSize: 12, fontWeight: 600, color: "var(--text)",
                display: "flex", alignItems: "center", gap: 8,
                background: "var(--s3)",
              }}>
                <span>{grupo.icon}</span>
                <span>{grupo.label}</span>
              </div>
              <div>
                {tipos.map((t, idx) => {
                  const enabled = prefs[t.id] ?? true;
                  const saving = savingType === t.id;
                  return (
                    <div key={t.id} style={{
                      display: "flex", alignItems: "flex-start", gap: 14,
                      padding: "14px 16px",
                      borderTop: idx === 0 ? "none" : "1px solid var(--bd)",
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          display: "flex", alignItems: "center", gap: 8,
                          fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 4,
                        }}>
                          <span style={{ fontSize: 15 }}>{t.emoji}</span>
                          <span>{t.label}</span>
                          {t.status === "proximamente" && (
                            <span style={{
                              fontSize: 9, padding: "2px 6px", borderRadius: 4,
                              background: "rgba(168,137,58,0.15)",
                              color: "var(--pase-gold)",
                              fontWeight: 600, letterSpacing: "0.04em",
                              textTransform: "uppercase",
                            }}>
                              Próximamente
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--muted2)", lineHeight: 1.5 }}>
                          {t.description}
                        </div>
                      </div>
                      <ToggleSwitch
                        checked={enabled}
                        disabled={saving}
                        onChange={(v) => toggle(t.id, v)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 20, fontSize: 11, color: "var(--muted2)", lineHeight: 1.5 }}>
        <strong>Tip:</strong> los tipos marcados como <em>Próximamente</em> ya están
        listos en la pantalla. Cuando el emisor correspondiente se active (cron de
        cierre, escalada del bot, etc.), las preferencias guardadas acá ya funcionan
        sin que tengas que volver.
      </div>
    </div>
  );
}

// ─── ToggleSwitch reutilizable, sin dependencias ────────────────────────
function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      style={{
        position: "relative",
        width: 40, height: 22,
        borderRadius: 999,
        background: checked ? "var(--pase-celeste, #75AADB)" : "var(--bd)",
        border: "none",
        cursor: disabled ? "wait" : "pointer",
        flexShrink: 0,
        transition: "background 0.18s ease",
        padding: 0,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{
        position: "absolute",
        top: 2,
        left: checked ? 20 : 2,
        width: 18, height: 18,
        borderRadius: "50%",
        background: "white",
        boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        transition: "left 0.18s ease",
      }}/>
    </button>
  );
}
